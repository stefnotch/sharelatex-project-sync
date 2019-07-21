import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { WSANOTINITIALISED } from "constants";

/**
 * Set `__statics` path to static files in production;
 * The reason we are setting it here is that the path needs to be evaluated at runtime
 */
if (process.env.PROD) {
  global.__statics = require("path")
    .join(__dirname, "statics")
    .replace(/\\/g, "\\\\");
}

let mainWindow;

function createWindow() {
  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false
    }
  });

  mainWindow.loadURL(process.env.APP_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

ipcMain.on("show-open-dialog", (event, arg) => {
  const options = {
    ...arg,
    //title: 'Open a file or folder',
    //defaultPath: '/path/to/something/',
    //buttonLabel: 'Do it',
    /*filters: [
        { name: 'xml', extensions: ['xml'] }
      ],*/
    properties: ["openDirectory"]
    //message: 'This message will only be shown on macOS'
  };

  dialog.showOpenDialog(mainWindow, options, filePaths => {
    event.sender.send("open-dialog-paths-selected", filePaths);
  });
});

ipcMain.on("open-new-window", (event, url) => {
  let win = new BrowserWindow({ width: 960, height: 540 });
  win.loadURL(url);
  win.show();
  let interval = 0;
  let sharelatexData = {
    sid: "",
    csrfToken: ""
  };
  let sent = false;
  let checkIfDone = () => {
    if (
      !sent &&
      sharelatexData &&
      sharelatexData.sid &&
      sharelatexData.sid.length > 0 &&
      sharelatexData.csrfToken &&
      sharelatexData.csrfToken.length > 0
    ) {
      sent = true;
      event.sender.send("sharelatex-data-grabbed", sharelatexData);
      win.close();
    }
  };

  win.on("close", () => {
    // Unregister the interval thingy
    clearInterval(interval);
    win = null;
  });

  win.webContents.on("did-finish-load", () => {
    interval = setInterval(async () => {
      win.webContents.session.cookies
        .get({
          domain: new URL(url).hostname,
          name: "sharelatex.sid"
        })
        .then(cookies => {
          if (cookies && cookies[0] && cookies[0].value) {
            sharelatexData.sid = cookies[0].value;
            checkIfDone();
          }
        });

      win.webContents.executeJavaScript("window.csrfToken").then(token => {
        if (token) {
          sharelatexData.csrfToken = token;
          checkIfDone();
        }
      });
    }, 300);
  });
});
