// Imports
const clear = require('clear');
const fs = require('fs');
const Lien = require('lien');
const open = require('open');
const google = require('googleapis');
const nsfw = require('nsfw');
const logger = require('nodemsg');
logger.config({
	before: '',
});
const path = require('path');
const prettyBytes = require('pretty-bytes');
var moment = require('moment');

// Constants
const CONFIG_PATH = 'config.json';

// Global variables
let error = null;
let quotaError = null;
let checkedTokens = false;
let tokenExpired = null;
let config = {};
let oauth2Client = null;
let monitoringRootFolder = false;

let waitingQueue = [];

let activeUpload = null;
let activeUploadPath = null;
let uploadSpeed = 0;
let lastBytesDispatched = 0;

let suspendedUpload = null;

let uploadedVideos = [];

let nDots = 0;

// Console feedback
const updateConsole = setInterval(function() {
	clear();
	if (error) {
		logger.error(error);
		logger.error(`Make sure you have a config.json file next to this index.js file.`);
		process.exit();
	}

	// Dots
	const dots = '.'.repeat(nDots);
	if (nDots++ == 3) nDots = 0;

	// Checking access tokens
	if (!checkedTokens) {
		logger.info(`Checking your access tokens${dots}`);
		return;
	}

	// Access tokens feedback
	if (tokenExpired == null) {
		logger.info(`Your config.json file has no accessTokens. Check your browser${dots}`);
		return;
	} else if (tokenExpired) {
		logger.info(`Your access tokens have expired. Check your browser${dots}`);
		return;
	} else logger.success('Got the tokens 💪');

	// Check if we're monitoring the root folder
	if (!monitoringRootFolder) return;
	const {rootFolder: root} = config;
	logger.info(`Listening to the ${root} folder${dots}\n`);

	// Uploaded videos
	for (let index = 0; index < uploadedVideos.length; index++) {
		const video = uploadedVideos[index];
		logger.success(`${video} uploaded successfully \u2713`);
	}

	// Active upload
	if (activeUpload) {
		// Calculate stats
		const bytesDispatched = activeUpload.req.connection._bytesDispatched;
		uploadSpeed = bytesDispatched - lastBytesDispatched;
		lastBytesDispatched = bytesDispatched;
		const fileSize = fs.statSync(activeUploadPath).size;
		const uploadPercentage = ((bytesDispatched / fileSize) * 100).toFixed(2);
		const fileBasename = path.basename(activeUploadPath);
		// Show stats
		logger.warning(`Uploading ${fileBasename}	${prettyBytes(bytesDispatched)}/${prettyBytes(fileSize)}(${uploadPercentage}%)@${prettyBytes(uploadSpeed)}/s`);
	}

	if (suspendedUpload) {
		logger.error(`${suspendedUpload} failed \u2717`);
	}

	// Waiting queue
	for (let index = 0; index < waitingQueue.length; index++) {
		const pathAfterRoot = waitingQueue[index].replace(root, '');
		logger.info(`${pathAfterRoot} is in the queue.`);
	}

	if (suspendedUpload) {
		let timeLeft = null;
		let now = moment();
		let losAngeles = now.clone().tz('America/Los_Angeles');
		let deadline = losAngeles
			.clone()
			.hour(0)
			.minute(0)
			.second(0);
		if (now.isAfter(deadline)) {
			let tomorrow = moment(new Date())
				.add(1, 'days')
				.hour(0)
				.minute(0)
				.second(0);
			timeLeft = tomorrow.diff(now, 'hours') + ' h ' + (tomorrow.diff(now, 'minutes') % 60) + ' min';
		} else {
			timeLeft = deadline.diff(now, 'hours') + ' h ' + (deadline.diff(now, 'minutes') % 60) + ' min';
		}
		logger.warning(`\nYou've reached your quota limit. Waiting until midnight Pacific Time to continue (${timeLeft} left).`);
	}
}, 1000);

// Load config
fs.readFile(CONFIG_PATH, (err, data) => {
	if (err) {
		error = err;
		return;
	}
	getCredentials(JSON.parse(data.toString()));
});

function getCredentials(configuration) {
	// Save to global variable
	config = configuration;
	// Get credentials
	const {credentials} = config;
	const {web} = credentials;
	const {client_secret: clientSecret, client_id: clientId, redirect_uris: redirectUrls} = web;
	const redirectUrl = redirectUrls[0];

	// Create OAuth2Client
	oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);

	// If there are no access tokens
	const {accessTokens} = config;
	if (!accessTokens.hasOwnProperty('access_token') || !accessTokens.hasOwnProperty('refresh_token') || !accessTokens.hasOwnProperty('scope') || !accessTokens.hasOwnProperty('token_type') || !accessTokens.hasOwnProperty('expiry_date')) {
		tokenExpired = null;
		checkedTokens = true;
		getNewTokens();
	} else if (config.accessTokens.expiry_date < new Date().getTime()) {
		tokenExpired = true;
		checkedTokens = true;
		getNewTokens();
	} else {
		tokenExpired = false;
		checkedTokens = true;
		monitorRootFolder();
	}
}

function getNewTokens() {
	// Init Lien server
	let server = new Lien({host: 'localhost', port: 5000});

	// Open this url in your default browser
	open(
		oauth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: ['https://www.googleapis.com/auth/youtube.upload'],
		})
	);

	// Handle oauth2 callback
	server.addPage('/oauth2callback', (lien) => {
		oauth2Client.getToken(lien.query.code, (err, tokens) => {
			if (err) {
				lien.lien(err, 400);
				return logger.error(`${err}`);
			}

			// Update config
			config = {...config, accessTokens: {...tokens}};

			// Store updated config to disk, to be used in later program executions
			storeConfig();

			// Update tokenExpired global variable
			tokenExpired = false;

			lien.end('You can close this tab and check the console log.');
		});
	});
}

function storeConfig() {
	fs.writeFile(CONFIG_PATH, JSON.stringify(config), (err) => {
		if (err) throw err;
		monitorRootFolder();
	});
}

function monitorRootFolder() {
	// Monitor root folder for changes
	const {rootFolder: root} = config;
	nsfw(root, function(events) {
		// Handle events
		const {action} = events[0];

		// Handle renaming events
		if (action == 3) {
			const {newDirectory, newFile} = events[0];
			const folderBasename = path.basename(newDirectory);
			const fileBasename = path.parse(newFile).name;
			const fullPath = `${newDirectory}/${newFile}`;
			if (folderBasename === fileBasename) {
				// Add to processing queue
				waitingQueue.push(fullPath);

				// If there's no active upload, start one
				if (activeUpload == null) {
					processNextVideo();
				}
			}
		}
	})
		.then(function(watcher) {
			watcher.start();
		})
		.then(function() {
			monitoringRootFolder = true;
		});
}

function processNextVideo() {
	// Check if there's anything in the waiting queue
	if (waitingQueue.length == 0) return;

	// Extract data from queue
	activeUploadPath = waitingQueue.shift(); // FIFO
	const title = path.parse(activeUploadPath).name;

	// Validations (thumbnail, metadata.json)
	// validateVideo(fullPath);

	// Set credentials for upload
	const {accessTokens} = config;
	oauth2Client.setCredentials(accessTokens);
	google.options({auth: oauth2Client});

	// Upload video to YouTube channel
	activeUpload = google.youtube('v3').videos.insert(
		{
			// Resource options: https://developers.google.com/youtube/v3/docs/videos/insert
			resource: {
				// Video title and description
				snippet: {
					title: `VS Code Setting: ${title}`,
					description: "In this video I explain what this VS Code setting is and how to set it up.\n\n👇SUBSCRIBE TO ANDRÉ'S YOUTUBE CHANNEL NOW👇\nhttps://www.youtube.com/channel/UCAVNclj3DbLvdJE5CUHfumg?sub_confirmation=1\n\n★☆★ CONNECT WITH ANDRÉ ON SOCIAL MEDIA★☆★\nAndreCasal.com: https://andrecasal.com\nYouTube: https://www.youtube.com/channel/UCAVNclj3DbLvdJE5CUHfumg\nTwitter: https://twitter.com/theandrecasal\n\nI hope you've enjoyed this video!",
					tags: ['web development', 'vs code', 'visual studio code', 'vs code settings', 'visual studio code settings', 'vs code setting', 'visual studio code setting', title],
				},
				// I don't want to spam my subscribers
				status: {
					privacyStatus: 'private',
				},
			},
			// This is for the callback function
			part: 'snippet,status',

			// Create the readable stream to upload the video
			media: {
				body: fs.createReadStream(activeUploadPath),
			},
		},
		(err, data) => {
			if (err) {
				quotaError = err;
				suspendedUpload = activeUploadPath;
				return;
			}
			// Add this video to the uploadedVideos list
			const pathAfterRoot = activeUploadPath.replace(root, '');
			uploadedVideos.push(pathAfterRoot);
			// Process next video
			processNextVideo();
		}
	);
}
