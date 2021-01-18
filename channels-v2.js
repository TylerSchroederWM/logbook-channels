const fs = require("fs");
const home = require("os").homedir();

var argv = require("minimist")(process.argv.slice(2));
var clientFactory = require("ssb-client");
var path = require("path");
var pull = require("pull-stream");
var many = require("./pull-many-v2");

// Change to 'true' to get debugging output
DEBUG = false

DEFAULT_CHANNEL_METADATA = {
	lastMsgTimestamp: 0
}
DEFAULT_CHANNEL_OBJECT = {
	messages: []
}
DEFAULT_CHANNEL_OBJECT_SIZE = 15
GRAPH_TYPE = "follow"
MESSAGE_SEPERATOR = "---------------"
MESSAGE_SEPERATOR_COLOR = "\x1b[33m"
MESSAGE_COLOR = "\x1b[0m"
SBOT_ROOT = path.join(home, ".ssb");
SBOT_CHANNEL_DIR = path.join(SBOT_ROOT, "channels");
SBOT_CHANNEL_DATA = path.join(SBOT_CHANNEL_DIR, ".data");

class StreamData {
	constructor() {
		this.finished = false,
		this.oldestTimestampSeen = Number.MAX_SAFE_INTEGER,
		this.waitingMessages = []

		this.markFinished = function() {
			this.finished = true,
			this.oldestTimestampSeen = 0
		}
	}
}

if (!fs.existsSync(SBOT_ROOT)) {
	debug("no ~/.ssb folder detected, creating it...");
	fs.mkdirSync(SBOT_ROOT);
}

if (!fs.existsSync(SBOT_CHANNEL_DIR)) {
	debug("no channels folder detected, creating it...");
	fs.mkdirSync(SBOT_CHANNEL_DIR);
}

if (!fs.existsSync(SBOT_CHANNEL_DATA)) {
	debug("no channel metadata file found, creating it...");
	fs.writeFileSync(SBOT_CHANNEL_DATA, "{}");
}

debug("Creating client...");
clientFactory(function (err, client) {
	if(err) {
		console.log("[FATAL] Error when starting scuttlebot: " + err);
		throw err;
	}
	debug("Successfully created client");


	main(client);
});

function main(client) {
	// var metadata = JSON.parse(fs.readFileSync(SBOT_CHANNEL_DATA));

	if(!argv._ || argv._.length == 0) {
		showHelp(metadata);
		client.close(true, () => {});
		process.exit(0);
	}

	var channelName = "#" + argv._[0];
	// var trackedChannelData = getChannelData(channelName, metadata); // only get data for the first channel given (easy to change this if needed)
	// var trackedChannelMessages = getChannelMessages(channelName);
	var trackedChannelMessages = DEFAULT_CHANNEL_OBJECT;
	// debug("fetched " + trackedChannelMessages["messages"].length + " messages from cache");

	client.friends.hops({
			dunbar: Number.MAX_SAFE_INTEGER,
			max: 3
		},
		function(err, hops) {
			if(err) {
				console.log("[FATAL] Could not retreive friends list (is ssb-friends installed?)")
				client.close(true, () => {});
				process.exit(4);
			}

			fetchChannelMessagesFrom(client, channelName, trackedChannelMessages, Object.keys(hops));
		}
	)
}

function fetchChannelMessagesFrom(client, channelName, trackedChannelMessages, hops) {
	// So it seems like Scuttlebutt IDs are case insensitive
	// This means that you can accidentially capitalize/uncapitalize letters when following someone, and the follow will still go through
	// However, the typo will remain in your friend graph and ruin any attempt made to query for that ID in its normal capitalization
	// To avoid this skullfuckery, we just use a list and map lower() onto it beforehand
	var followedIds = hops.map(id => id.toLowerCase());

	debug("Fetching messages from IDs in " + JSON.stringify(followedIds));

	var streamController = {
		assembledMessages: [],
		streamData: {
			hashtagStream: new StreamData(),
			channelStream: new StreamData()
		},
		pushMessage: function(source, newMsg) {
			var streamData = source == "hashtag" ? this.streamData.hashtagStream : this.streamData.channelStream;
			streamData.oldestTimestampSeen = newMsg.value.timestamp;
			streamData.waitingMessages.push(newMsg);

			this.printNewlySafeMessages();
		},
		printNewlySafeMessages: function() {
			var newlySafeMessages = [];
			var oldestSafeTimestamp = Math.max(...Object.values(this.streamData).map(datum => datum.oldestTimestampSeen));
			debug("oldest safe timestamp:" + oldestSafeTimestamp);

			for(var streamDataIndex in this.streamData) {
				var streamDatum = this.streamData[streamDataIndex]
				debug("length of waiting messages: " + streamDatum.waitingMessages.length);
				if(streamDatum.waitingMessages.length) {
					debug("timestamp of first waiting message: " + streamDatum.waitingMessages[0].value.timestamp);
				}
				while(streamDatum.waitingMessages.length && streamDatum.waitingMessages[0].value.timestamp >= oldestSafeTimestamp) {
					var safeMsg = streamDatum.waitingMessages.shift(); // pop the newest waiting message
					newlySafeMessages.push(safeMsg);
				}
			}

			// in general, newlySafeMessages might not be in order, we should sort before appending
			newlySafeMessages.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));
			this.assembledMessages = this.assembledMessages.concat(newlySafeMessages);
			for(var msgIndex in newlySafeMessages) {
				printMsg(newlySafeMessages[msgIndex]);
			}
			debug("***************");
		},
		finish: function() {
			for(var datumIndex in this.streamData) {
				this.streamData[datumIndex].oldestTimestampSeen = 0;
			}
			this.printNewlySafeMessages();
		}
	}

	var hashtagStream = createHashtagStream(client, channelName);
	var channelStream = createChannelStream(client, channelName);
	var stream = many([hashtagStream, channelStream]);

	pull(stream, pull.filter(function(msg) {
		return followedIds.includes(msg.data.value.author.toLowerCase());
	}), pull.filter(function(msg) {
		var hasHashtag =  msg.data.value.content && msg.data.value.content.text && typeof(msg.data.value.content.text) == "string" && msg.data.value.content.text.includes(channelName);
		if(msg.source == "hashtag") {
			return hasHashtag;
		}
		else {
			return !hasHashtag; // prevents us from double-counting messages with both the hashtag and the channel header
		}
	}), pull.drain(function(msg) {
		streamController.pushMessage(msg.source, msg.data);
	}, function() {
		streamController.finish();
		client.close(true, () => {});
		process.exit(0);
	}));
}

function saveMessages(client, taskData, channelName, trackedChannelMessages, metadata) {
	debug("found " + taskData.msgsFound + " new messages");
	debug(JSON.stringify(taskData));
	console.log("Found " + trackedChannelMessages["messages"].length + " messages:");

	updateChannelMessages(channelName, trackedChannelMessages, metadata, taskData.lastTimestamp);

}

function showHelp(metadata) {
	console.log("No channel provided. To get messages for a channel, run 'node channels.js example'");
        console.log("(note that 'node channels.js #example' will not work, because # is a protected character)");

        var trackedChannels = getTrackedChannels(metadata);
        if(trackedChannels.length) {
                console.log("Currently tracked channels are:");
                for(const channelNameIndex in trackedChannels) {
			var stats = fs.statSync(path.join(SBOT_CHANNEL_DIR, trackedChannels[channelNameIndex]));
			if(stats.size > DEFAULT_CHANNEL_OBJECT_SIZE) { // don't say we're tracking empty channels -- if they were interesting, they'd have stuff in them
				console.log(trackedChannels[channelNameIndex]);
			}
                }
        }
        else {
                console.log("No channels are currently tracked.");
        }
}

function getTrackedChannels(data) {
		return Object.keys(data);
}

function getChannelData(channelName, data) {
	if(!data[channelName]) {
		data[channelName] = {
			lastMsgTimestamp: 0,
		}
	}

	return data[channelName];
}

function getChannelMessages(channelName) {
	var messageCachePath = path.join(SBOT_CHANNEL_DIR, channelName);
	if (!fs.existsSync(messageCachePath)) {
		return DEFAULT_CHANNEL_OBJECT;
	}

	var raw = fs.readFileSync(messageCachePath, "utf8");
	return JSON.parse(raw);
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

	query.streamName = "hashtag"; // mark the stream object so we can tell which stream an object came from

	return query;
}

function createChannelStream(client, channelName) {
	var query = client.query.read({
		query: [{
                       	"$filter": {
                               	value: {
                                       	content: {
                                               	channel: channelName.substring(1)
                                        }
                        	}
       	        	}
                }],
               	reverse: true
	});

	query.streamName = "channel"; // mark the stream object so we can tell which stream a message came from later

	return query;
}

function printMsg(msg) {
	console.log(MESSAGE_SEPERATOR_COLOR, MESSAGE_SEPERATOR);
	console.log(MESSAGE_COLOR, msg.value.content.text);
}

function updateChannelMessages(channelName, channelJson, metadata, latestTimestamp) {
	fs.writeFileSync(path.join(SBOT_CHANNEL_DIR, channelName), JSON.stringify(channelJson));

	if(metadata.channelName == undefined) {
		metadata[channelName] = DEFAULT_CHANNEL_METADATA;
	}

	metadata[channelName].lastMsgTimestamp = latestTimestamp; // once we've successfully updated messages, update the most recent message ID
	fs.writeFileSync(SBOT_CHANNEL_DATA, JSON.stringify(metadata));
}

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[" + timestamp.toISOString() + "] " +  message);
	}
}
