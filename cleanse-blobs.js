const pull = require("pull-stream");
const clientFactory = require("ssb-client");
const fs = require("fs");
const home = require("os").homedir();
const path = require("path");

// Change to 'true' to get debugging output
DEBUG = false

LOOP_TIME = 5 * 60 * 1000 // 5 minutes in milliseconds

SBOT_ROOT = path.join(home, ".ssb");
SBOT_BLOB_DIR = path.join(SBOT_ROOT, "blobs");
SBOT_BLOBS_FILE = path.join(SBOT_BLOB_DIR, "allowed_blobs");

function getPermittedBlobIds() {
	let contents = fs.readFileSync(SBOT_BLOBS_FILE, "utf8");
	return contents.split("\n"); // this could cause slowdowns if the metadata file is several gigabytes, but i don't forsee that happening
}

function ensureFiles() {
	if (!fs.existsSync(SBOT_ROOT)) {
		debug("no ~/.ssb folder detected, creating it...");
		fs.mkdirSync(SBOT_ROOT);
	}

	if (!fs.existsSync(SBOT_BLOB_DIR)) {
		debug("no blobs folder detected, creating it...");
		fs.mkdirSync(SBOT_BLOB_DIR);
	}

	if (!fs.existsSync(SBOT_BLOBS_FILE)) {
		debug("no metadata file found, creating it...");
		fs.writeFileSync(SBOT_BLOBS_FILE, "");
	}
}

function recursiveCleanseBlobs(client) {
	let permittedBlobIds = getPermittedBlobIds();

	pull(
		client.blobs.ls(),
		pull.filter(function(id) {
			return !permittedBlobIds.includes(id);
		}),
		pull.drain(function(id) {
			client.blobs.rm(id, function () {
				debug("Removed blob with ID " + id);
			});
		}) // possibly better is to set a global variable marking when this is done so we can wait and run it again, but that would make me throw up
	)
}

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[channels-lib] [" + timestamp.toISOString() + "] " +  message);
	}
}

clientFactory(function(err, client) {
	ensureFiles();
	setInterval(recursiveCleanseBlobs, LOOP_TIME, client);
});
