<template>
  <q-page class="flex flex-center">
    <q-card>
      <q-card-section>
        <div class="text-h6">Options</div>
      </q-card-section>
      <q-card-section>
        <q-input v-model="url" label="Project URL" stack-label :dense="true" />
        <br />
        <q-btn icon="mail" label="Select Folder" @click="setFolderPath" />
        <span>&nbsp;{{outputFolderPath}}</span>
      </q-card-section>
      <q-separator />

      <q-card-actions vertical>
        <q-btn
          color="primary"
          @click="startSync()"
          class="full-width"
          label="Sync"
          :loading="isSyncing"
        ></q-btn>
      </q-card-actions>
    </q-card>
    <span v-if="error" color="red">{{error}}</span>
  </q-page>
</template>

<style>
</style>

<script>
import { ipcRenderer } from "electron";
import util from "util";
import fs from "fs";
import path from "path";
import stream from "stream";
import request from "request";

/**
 * @typedef {{_id: string, name: string, linkedFileData: any, created: string}} FileRef
 */
/**
 * @typedef {{_id: string, name: string}} Doc
 */
/**
 * @typedef {{_id: string, name: string, folders:Folder[], fileRefs: FileRef[], docs: Doc[]}} Folder
 */

export default {
  name: "PageIndex",
  data() {
    return {
      url: "",
      outputFolderPath: ".",
      sid: "",
      csrfToken: "",
      fileHashes: {},
      isSyncing: false,
      downloadCount: 0,
      cachedCount: 0,
      error: "",
      /** @type {WebSocket|null} */
      websocket: null,
      websocketPromises: [],
      websocketMessages: [],
      websocketResponseIndex: 1,
      websocketResponsePromises: []
    };
  },
  watch: {
    url(newValue) {
      localStorage["url"] = newValue;
    },
    outputFolderPath(newValue) {
      localStorage["folderPath"] = newValue;
    },
    fileHashes(newValue) {
      localStorage["fileHashes-" + this.projectId] = JSON.stringify(newValue);
    }
  },
  computed: {
    urlBase() {
      try {
        let urlObject = new URL(this.url);
        return urlObject.origin;
      } catch (e) {
        return "";
      }
    },
    projectId() {
      try {
        let urlObject = new URL(this.url);
        return urlObject.pathname.match(/\/?project\/([^\/]+)/)[1];
      } catch (e) {
        return "";
      }
    }
  },
  mounted() {
    this.url = localStorage["url"] || "";
    this.outputFolderPath = localStorage["folderPath"] || "";
    if (this.projectId) {
      let json;
      try {
        json = JSON.parse(localStorage["fileHashes-" + this.projectId]);
      } catch (e) {
        json = undefined;
      }
      this.fileHashes = json || {};
    }
    this.invalidateOutdatedHashes();

    let self = this;
    ipcRenderer.on("open-dialog-paths-selected", (event, arg) => {
      console.log(arg);
      self.outputFolderPath = arg[0];
    });

    ipcRenderer.on("sharelatex-data-grabbed", (event, arg) => {
      console.log(arg);
      self.sid = arg.sid;
      self.csrfToken = arg.csrfToken;
      self.sync();
    });
  },
  beforeDestroy() {
    ipcRenderer.removeAllListeners("open-dialog-paths-selected");
    ipcRenderer.removeAllListeners("sharelatex-data-grabbed");
  },
  methods: {
    setFolderPath() {
      ipcRenderer.send("show-open-dialog", {
        defaultPath: this.outputFolderPath
      });
    },
    startSync() {
      this.isSyncing = true;
      ipcRenderer.send("open-new-window", this.url);
    },
    responseToReadable(response) {
      const reader = response.body.getReader();
      const rs = new stream.Readable();
      rs._read = async () => {
        const result = await reader.read();
        if (!result.done) {
          rs.push(Buffer.from(result.value));
        } else {
          rs.push(null);
          return;
        }
      };
      return rs;
    },
    getLocalFileHash(remotePath) {
      try {
        return (
          fs.statSync(path.join(this.outputFolderPath, remotePath)).mtimeMs + ""
        );
      } catch (e) {
        return undefined;
      }
    },
    invalidateOutdatedHashes() {
      let filteredFileHashes = {};
      Object.keys(this.fileHashes).forEach(path => {
        let localHash = this.getLocalFileHash(path);
        if (localHash && this.fileHashes[path].localHash == localHash) {
          filteredFileHashes[path] = this.fileHashes[path];
        }
      });
      this.fileHashes = filteredFileHashes;
    },
    /**
     * @type {object} data
     */
    getChannelResponse(data) {
      let index = this.websocketResponseIndex;
      if (data) {
        this.websocketResponseIndex++;
        this.websocket.send(`5:${index}+::${JSON.stringify(data)}`);

        return new Promise((resolve, reject) => {
          this.websocketResponsePromises[index] = {
            resolve: resolve,
            reject: reject
          };
        });
      }
    },
    /**
     * @type {RegExp} regex
     */
    async expectChannelMessage(regex) {
      let responseText = "";
      if (this.websocketMessages.length <= 0) {
        // Wait
        responseText = await new Promise((resolve, reject) => {
          this.websocketPromises.push({
            resolve: resolve,
            reject: reject
          });
        });
      } else {
        responseText = this.websocketMessages.shift() + "";
      }

      let match = responseText.match(regex);
      if (!match) {
        throw new Error(`Expected ${regex} but got ${responseText}`);
      }
      return match;
    },
    async joinProject() {
      let channel = await fetch(
        `${this.urlBase}/socket.io/1/?t=${Date.now().toString()}`,
        {
          headers: {
            Cookie: `sharelatex.sid=${this.sid}`,
            "X-Csrf-Token": this.csrfToken
          }
        }
      ).then(response => response.text());
      channel = channel.split(":")[0];

      this.websocket = new WebSocket(
        `${this.urlBase.replace("http", "ws")}/socket.io/1/websocket/${channel}`
      );

      this.websocket.addEventListener("message", evt => {
        if ((evt.data + "").startsWith("2::")) return;

        if ((evt.data + "").startsWith("6:")) {
          // ID stuff
          let id = evt.data.match(/^6:[^+]+?(\d+)\+/)[1];
          if (this.websocketResponsePromises[id]) {
            // index exists
            let dataString = evt.data.substring(evt.data.indexOf("+") + 1);
            this.websocketResponsePromises[id].resolve(JSON.parse(dataString));
          } else {
            console.error(`Unexpected response ${evt.data}`);
          }
        } else {
          // A response
          if (this.websocketPromises.length > 0) {
            // Someone is waiting for the message
            this.websocketPromises.shift().resolve(evt.data);
          } else {
            // Backbuffer
            this.websocketMessages.push(evt.data);
          }
        }
      });

      await this.expectChannelMessage(/^1::$/);
      let connectionAccepted = await this.expectChannelMessage(/^5:::({.+})$/);
      if (JSON.parse(connectionAccepted[1]).name !== "connectionAccepted") {
        throw new Error(`connected rejected: ${connectionAccepted.toString()}`);
      }

      // We have now successfully connected to the socket.io channel
      // Now join the project
      let joinProject = await this.getChannelResponse({
        name: "joinProject",
        args: [{ project_id: this.projectId }]
      });

      return joinProject[1];
    },
    async sync() {
      try {
        this.error = "";
        this.downloadCount = 0;
        this.cachedCount = 0;
        this.invalidateOutdatedHashes();
        let project = await this.joinProject();
        console.log(project);

        let rootFolder = project.rootFolder[0];
        await this.syncFolder(rootFolder, "/");
        console.log("Completed without errors");
      } catch (e) {
        console.error(e);
        this.error = e;
      } finally {
        // Done
        this.isSyncing = false;
        if (this.websocket) {
          this.websocket.close();
        }
        this.websocketMessages = [];
        this.websocketPromises = [];
        this.websocketResponseIndex = 1;
        this.websocketResponsePromises = [];

        this.$q.notify({
          message: `Synced ${this.downloadCount + this.cachedCount} files, ${
            this.cachedCount
          } were cached.`,
          position: "bottom",
          actions: [
            {
              label: "Ok",
              handler: () => {}
            }
          ]
        });
      }
    },
    /**
     * @param {Folder} folder
     */
    async syncFolder(folder, parentFolderPath) {
      let folderPath = parentFolderPath + folder.name + "/";

      // Create the folder
      await fs.promises.mkdir(path.join(this.outputFolderPath, folderPath), {
        recursive: true
      });

      // Sync the files
      for (let i = 0; i < folder.fileRefs.length; i++) {
        await this.syncFile(folder.fileRefs[i], folderPath);
      }

      // sync the documents
      for (let i = 0; i < folder.docs.length; i++) {
        await this.syncDoc(folder.docs[i], folderPath);
      }

      // Sync the sub-folders
      for (let i = 0; i < folder.folders.length; i++) {
        await this.syncFolder(folder.folders[i], folderPath);
      }
    },
    /**
     * @param {FileRef} file
     */
    async syncFile(file, folderPath) {
      let filePath = folderPath + file.name;
      let hash = file.created;

      // If the hashes are the same, don't bother syncing it
      if (
        this.fileHashes[filePath] &&
        this.fileHashes[filePath].remoteHash == hash
      ) {
        console.log(`${filePath} has already been synced, skipping it`);
        this.cachedCount++;
        return;
      } else {
        const response = await fetch(
          `${this.urlBase}/project/${this.projectId}/file/${file._id}`,
          {
            headers: {
              Cookie: `sharelatex.sid=${this.sid}`,
              "X-Csrf-Token": this.csrfToken
            }
          }
        );
        if (!response.ok) {
          throw new Error(`unexpected response ${response.statusText}`);
        }

        await new Promise((resolve, reject) => {
          let destination = path.join(this.outputFolderPath, filePath);
          let fileStream = fs.createWriteStream(destination);
          let readable = this.responseToReadable(response);
          readable.pipe(fileStream);
          fileStream.on("finish", () => {
            resolve();
          });
          readable.on("error", err => {
            fs.unlink(destination);
            reject(err);
          });
        });
        this.downloadCount++;

        this.$set(this.fileHashes, filePath, {
          remoteHash: hash,
          localHash: this.getLocalFileHash(filePath)
        });
      }
    },
    /**
     * @param {Doc} doc
     */
    async syncDoc(doc, folderPath) {
      let docPath = folderPath + doc.name;

      // TODO: Sync the doc
      // Join doc
      let docResponse = await this.getChannelResponse({
        name: "joinDoc",
        args: [doc._id, { encodeRanges: true }]
        // encodeForWebsockets = (text) -> unescape(encodeURIComponent(text))
      });

      let hash = docResponse[2] + "";
      let lines = docResponse[1];

      await new Promise((resolve, reject) => {
        let destination = path.join(this.outputFolderPath, docPath);
        let fileStream = fs.createWriteStream(destination);

        lines.forEach(line => {
          fileStream.write(decodeURIComponent(escape(line)), "utf-8");
          fileStream.write("\n", "utf-8");
        });
        fileStream.end();
        fileStream.on("finish", () => {
          resolve(true);
        });
        fileStream.on("error", err => {
          fs.unlink(destination);
          reject(err);
        });
      });

      this.downloadCount++;

      this.$set(this.fileHashes, docPath, {
        remoteHash: hash,
        localHash: this.getLocalFileHash(docPath)
      });

      // Leave doc
      await this.getChannelResponse({ name: "leaveDoc", args: [doc._id] });
    }
  }
};
</script>
