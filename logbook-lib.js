var clientFactory = require("ssb-client");
var config = require("ssb-config");
var pull = require("pull-stream");
var Pushable = require("pull-pushable");
var many = require("pull-many");

// Change to 'true' to get debugging output
DEBUG = false

// Change to switch the default monitored channel
DEFAULT_CHANNEL_NAME = "logbook"

DEFAULT_OPTS = {
	lt: Date.now(),
	gt: -Infinity
}
GRAPH_TYPE = "follow"
MAX_HOPS = 1
MAX_REPLY_RECURSIONS = 10

// using global variables to this extent is horrifying, but javascript has forced my hand
let client = null;
let outputStream = Pushable();
let allowedBlobs = [];
let idsInMainChannel = {};
let allMessages = {};
let messagesByUser = {};
let opts = DEFAULT_OPTS;

function pushMessage(newMsg) {
	if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
		idsInMainChannel[newMsg.value.author] = true;
		allMessages[newMsg.key] = newMsg;
		requestBlobs(newMsg);
	}
}

function sortAndPushAllMessages() {
	let messages = Object.keys(allMessages).map(function(msgId) { return allMessages[msgId]; });
	for(let msg of messages.sort((a, b) => b.value.timestamp - a.value.timestamp)) {
		outputStream.push(msg);
	}
}

function getReplies(unchckedMessages) {
	let replyStreams = [];

	for(userId of Object.entries(idsInMainChannel)) {
		messagesByUser[userId] = [];
		replyStreams.push(createUserStream(client, userId));
	}

	let newMessages = {};
	let foundNewMessages = false;
	pull(
		many(replyStreams),
		pull.filter(function(msg) {
			userMessages[msg.value.author].push(msg);
			let messageIsValid = (value in msg) && (content in msg.value) && (root in msg.value.content);
			return messageIsValid && !(msg.key in uncheckedMessages) && (msg.value.content.root in uncheckedMessages);
		}),
		pull.drain(function(msg) {
			pushMessage(msg);

			newMessages[msg.key] = msg;
			foundNewMessages = true;
		},
		function() {
			sortAndPushAllMessages();
			getRelevantProfilePictures();
		})
	);
}

function requestBlobs(msg) {
	if(msg.value && msg.value.content) {
		if(msg.value.content.mentions && Symbol.iterator in Object(msg.value.content.mentions)) {
			for(let mention of msg.value.content.mentions) {
				if(mention.type && mention.link) {
					if(typeof mention.link == "string") {
						getBlob(mention.link)
					}
					else {
						debug("Message has non-string mention.link value: " + JSON.stringify(mention.link));
					}
				}
			}
		}
	}
}

function getRelevantProfilePictures() {
	let relevantIds = Object.keys(idsInMainChannel);
	let profilePictureStreams = []
	let profilePictureFound = {};

	for(let userId of relevantIds) {
		profilePictureFound[userId] = false;
		profilePictureStreams.push(createMetadataStream(client, userId));
	}
	let collectedStream = many(profilePictureStreams);

	if(relevantIds.length == 0) { // avoid the edge case where checkIfDone is never called
		exit();
	}

	pull(
		collectedStream,
		pull.drain(function(msg) {
			if(!profilePictureFound[msg.value.author] && msg.value.content.image) {
				if(typeof msg.value.content.image == "string") {
					debug("Getting profile picture at " + msg.value.content.image + " for user " + msg.value.author);
					getBlob(msg.value.content.image);
					profilePictureFound[msg.value.author] = true;
				}
				else if(typeof msg.value.content.image == "object" && typeof msg.value.content.image.link == "string") {
					debug("Getting profile picture at " + msg.value.content.image.link + " for user " + msg.value.author);
					getBlob(msg.value.content.image.link);
					profilePictureFound[msg.value.author] = true;
				}
				else {
					debug("Message has unknown msg.value.content.image value: " + JSON.stringify(msg.value.content.image));
				}
			}
		}, function() {
			exit();
		})
	);
}

function getBlob(blobId) {
	allowedBlobs.push(blobId);

	debug("Ensuring existence of blob with ID " + blobId);
	client.blobs.has(blobId, function(err, has) {
		if(err) {
			debug("[ERROR] ssb.blobs.has failed on the blob with ID " + blobId);
		}
		if(!err && !has) {
			debug("Wanting blob with ID " + blobId);
			client.blobs.want(blobId, () => {});
		}
	});
}

function exit() { // is called at the end of the getReplies -> getRelevantProfilePictures chain
	outputStream.end();
}

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[channels-lib] [" + timestamp.toISOString() + "] " +  message);
	}
}

function createHashtagStream(client, channelName) {
	var search = client.search && client.search.query;
        if(!search) {
                console.log("[FATAL] ssb-search plugin must be installed to us channels");
                process.exit(5);
        }

        var query = search({
                query: channelName
        });

	return query;
}

function createChannelStream(client, channelName) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                                       	content: {
                                               	channel: channelName
                                        	}
                        		}
       	        	}
                }],
               reverse: true
	});

	return query;
}

function createUserStream(client, userId) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                                       	author: userId
                        		}
       	        	}
                }],
               reverse: true
	});

	return query;
}

function createMetadataStream(client, userId) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                               		author: userId,
                                       	content: {
                                               	type: "about"
                                        	}
                        		}
       	        	}
                }]
	});

	query.streamName = userId; // mark the stream object so we can tell which stream a message came from later

	return query;
}

function getMessagesFrom(channelName, followedIds, preserve, cb) {
	var channelTag = "#" + channelName;
	var hashtagStream = createHashtagStream(client, channelName);
	var channelStream = createChannelStream(client, channelName);
	var stream = many([hashtagStream, channelStream]);

	pull(stream, pull.filter(function(msg) {
		return followedIds.includes(msg.value.author.toLowerCase());
	}), pull.drain(function(msg) {
		pushMessage(msg);
	}, function() {
		getReplies(allMessages);
	}));

	cb(outputStream, preserve);
}

function getConfig() {
	return {
		host: config.host || "localhost",
		port: config.port || 8008
	}
}

module.exports = {
	getMessages: function(ssbClient, channelName, ssbOpts, preserve, cb, hops=MAX_HOPS) {
		client = ssbClient; // set global variables
		opts = ssbOpts;

		client.friends.hops({
			dunbar: Number.MAX_SAFE_INTEGER,
			max: hops
		}, function(error, friends) {
			if(error) {
				throw "Couldn't get a list of friends from scuttlebot:\n" + error;
			}

			var followedIds = Object.keys(friends).map(id => id.toLowerCase());
			getMessagesFrom(channelName, followedIds, preserve, cb);
		});
	}
}
