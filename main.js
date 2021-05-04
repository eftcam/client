// Modules to control application life and create native browser window
const {
	app,
	BrowserWindow,
	Menu,
	Tray,
	ipcRenderer,
	contextBridge,
	ipcMain,
	shell,
	dialog,
	session,
} = require("electron")

const path = require("path")

const { exec } = require("child_process")
const chokidar = require("chokidar")
const fetch = require("node-fetch")
const FormData = require("form-data")
const { getVideoDurationInSeconds } = require("get-video-duration")
var ffmpeg = require("fluent-ffmpeg")
ffmpeg.setFfmpegPath(require("ffmpeg-static"))
const { v4: uuidv4 } = require("uuid")
const Store = require("electron-store")
const store = new Store()

const appFolder = path.dirname(process.execPath)
const updateExe = path.resolve(appFolder, "..", "Update.exe")
const exeName = path.basename(process.execPath)

app.setLoginItemSettings({
	openAtLogin: true,
	path: updateExe,
	args: [
		"--processStart",
		`"${exeName}"`,
		"--process-start-args",
		`"--hidden"`,
	],
})

let URL = `https://eftcam.com`
if (!app.isPackaged) {
	URL = "http://localhost:3000"
}

const icon = __dirname + "/icon.png" // not sure if __dirname or .png fixed it, but ill take it
let isQuiting
let tray
function createWindow() {
	const width = app.isPackaged ? 800 : 1600 // dev tools take space
	let win = new BrowserWindow({
		width,
		height: 600,
		title: "EFTcam.com",
		icon,
		resizable: false,

		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
		},
	})

	win.on("minimize", function (e) {
		e.preventDefault()
		win.hide()
	})

	win.on("close", function (e) {
		if (!isQuiting) {
			e.preventDefault()
			win.hide()
		}
		return false
	})

	var contextMenu = Menu.buildFromTemplate([
		{
			label: "Open",
			click: function () {
				win.show()
			},
		},
		{
			label: "Quit EFTcam",
			click: function () {
				isQuiting = true
				app.quit()
			},
		},
	])

	tray = new Tray(icon)
	tray.setToolTip("EFTcam.com")
	tray.setContextMenu(contextMenu)

	// tray.setHighlightMode("always")
	tray.on("click", () => {
		win.show()
	})

	win.setMenu(null)
	// Load a remote URL
	win.loadURL(`${URL}/connected`)

	win.webContents.on("new-window", function (event, url) {
		event.preventDefault()
		shell.openExternal(url)
	})

	function watch(dir) {
		const watcher = chokidar.watch(dir, {
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 1000 * 5, // 2000
				pollInterval: 1000 * 5, // 100,
			},
			ignoreInitial: true,
		})
		watcher.on("add", async (path) => {
			console.log(`File ${path} has been added`)
			if (path.endsWith("-1.mp4") || path.endsWith("-1.png")) return // dont process multiple times

			console.log("processing...")
			let rename = `${uuidv4()}-1`
			win.webContents.send("fromMain", { type: "processing", id: rename })
			try {
				const length = store.get("clipopt").duration
				const seconds = parseInt(await getVideoDurationInSeconds(path), 10)
				console.log({ seconds, length })
				// const commands = `-s hd720 -c:v libx264 -crf 22 -vf "scale=iw*sar:ih,setsar=1" -c:a aac -b:a 160k`
				let patharr = path.split(".mp4")[0].split("\\")
				let filename = patharr[patharr.length - 1]
				filename = rename
				const filepath = patharr.slice(0, patharr.length - 1)

				let resolution = `hd720`
				if (length >= 61) {
					resolution = `hd1080`
				}

				await new Promise((resolve, reject) => {
					ffmpeg(path)
						.screenshot({
							timestamps: [Math.max(0, seconds - length)],
							count: 1,
							filename: `${filepath.join("\\")}\\${filename}.png`,
						})
						.on("end", resolve)
						.on("error", reject)
				})
				await new Promise((resolve, reject) => {
					ffmpeg(path)
						.outputOptions(
							`-s ${resolution} -c:v libx264 -crf 22 -vf scale=iw*sar:ih,setsar=1 -c:a aac -b:a 160k -ss ${parseInt(
								Math.max(0, seconds - length)
							)} -t ${Math.min(seconds, length)}`.split(" ")
						)
						.format("mp4")
						.save(`${filepath.join("\\")}\\${filename}.mp4`)
						.on("end", resolve)
						.on("error", reject)
				})
				// await new Promise((r) => setTimeout(r, 1000 * 5))
				console.log("saved")

				await upload_file(
					`${filepath.join("\\")}\\${filename}.png`,
					`${filename}.png`
				)
				await upload_file(
					`${filepath.join("\\")}\\${filename}.mp4`,
					`${filename}.mp4`
				)

				win.webContents.send("fromMain", {
					type: "upload",
					id: filename,
					seconds,
				})

				async function upload_file(filepath, filename) {
					const cookies = await session.defaultSession.cookies.get({})

					const res = await fetch(
						`${URL}/api/upload-url?duration=${seconds}&file=${encodeURIComponent(
							filename
						)}`,
						{
							headers: {
								cookie: cookies
									.map(({ name, value }) => `${name}=${value}`)
									.join("; "),
							},
						}
					)

					if (!res.ok) {
						throw new Error(await res.text())
					}

					const { url, fields } = await res.json()
					const formData = new FormData()

					Object.entries({
						...fields,
					}).forEach(([key, value]) => {
						formData.append(key, value)
					})

					console.log({
						filepath,
					})

					formData.append("file", require("fs").createReadStream(filepath), {
						knownLength: require("fs").statSync(filepath).size,
					})

					const upload = await fetch(url, {
						method: "POST",
						body: formData,
					})

					if (upload.ok) {
						console.log("Uploaded successfully!")
					} else {
						console.error("Upload failed.")
					}
				}
			} catch (err) {
				win.webContents.send("fromMain", {
					type: "processing",
					id: rename,
					err: err.message,
				})

				console.error(err)
			}
		})

		return () => watcher.close()
	}

	win.webContents.on("dom-ready", () => {
		console.log("dom-ready")

		if (!store.get("dir")) {
			store.set("dir", [
				`${require("os").homedir()}\\Videos\\Escape From Tarkov`,
			])
		}
		if (!store.get("clipopt")) {
			store.set("clipopt", { duration: 30 })
		}

		let old_watch_close_fn
		async function resetwatch() {
			let dir = store.get("dir")
			if (dir) {
				dir = dir[0]
			}

			if (old_watch_close_fn) {
				await old_watch_close_fn()
			}

			old_watch_close_fn = watch(dir)
		}

		ipcMain.on("toMain", async (event, data) => {
			console.log(Date.now())
			console.log("ipcMain toMain")
			console.log(data)
			const { type, ...rest } = data

			if (type === "opendir") {
				// shell.showItemInFolder("filepath") // Show the given file in a file manager. If possible, select the file.
				shell.openPath(store.get("dir")[0]) // Open the given file in the desktop's default manner.
				return
			}

			if (type === "storedir") {
				const result = await dialog.showOpenDialog(win, {
					properties: ["openDirectory", "promptToCreate"],
				})
				if (result.canceled) return
				store.set("dir", result.filePaths)
				win.webContents.send("fromMain", {
					type: "setdir",
					dir: result.filePaths,
				})
				await resetwatch()
				return
			}

			if (type === "storeclipopt") {
				store.set("clipopt", rest)
				win.webContents.send("fromMain", {
					type: "clipopt",
					...store.get("clipopt"),
				})
				return
			}

			if (type === "watch") {
				if (store.get("clipopt")) {
					win.webContents.send("fromMain", {
						type: "clipopt",
						...store.get("clipopt"),
					})
				}
				if (store.get("dir")) {
					win.webContents.send("fromMain", {
						type: "setdir",
						dir: store.get("dir"),
					})
				}

				await resetwatch()
				return
			}

			win.webContents.send("fromMain", "test123")
		})

		exec(
			"wmic path win32_VideoController get name",
			(error, stdout, stderr) => {
				if (error) {
					console.log(`error: ${error.message}`)
					return
				}
				if (stderr) {
					console.log(`stderr: ${stderr}`)
					return
				}
				// Normalise the result here to get the GPU name
				console.log(`stdout: ${stdout}`)

				win.webContents.send("fromMain", {
					type: "gpu",
					is_nvidia: stdout.toLowerCase().includes("NVIDIA".toLowerCase()),
				})
			}
		)
	})

	if (!app.isPackaged) win.webContents.openDevTools()
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
	createWindow()

	app.on("activate", function () {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", function () {
	if (process.platform !== "darwin") app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
