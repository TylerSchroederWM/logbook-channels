var clientFactory = require("ssb-client");
var config = require("ssb-config");
var fs = require("fs");
var pull = require("pull-stream");
var Pushable = require("pull-pushable");
var many = require("pull-many");
var path = require("path");
const home = require("os").homedir();

// Change to 'true' to get debugging output
DEBUG = !false

DEFAULT_OPTS = {
	lt: Date.now(),
	gt: -Infinity
}
GRAPH_TYPE = "follow"
MAX_HOPS = 1

SBOT_ROOT = path.join(home, ".ssb");
SBOT_BLOB_DIR = path.join(SBOT_ROOT, "blobs");
CACHE_FILEPATH = path.join(SBOT_ROOT, "logbook_cache");
SBOT_BLOBS_FILE = path.join(SBOT_BLOB_DIR, "allowed_blobs");
PATHS = [SBOT_ROOT, SBOT_BLOB_DIR, CACHE_FILEPATH]
FILES = [SBOT_BLOBS_FILE]
ensureFiles();

// only instantiate a ssb-client once, so we don't have to create a new connection every time we load a channel page
let client = null;
let memoryCache = {};
let allowedBlobs = readAllowedBlobs();

class ChannelController {
	constructor(opts) {
		this.opts = opts,
		this.outputStream = Pushable(),
		this.idsInChannel = {},
		this.streamOpen = {
			"channel": true,
			"hashtag": true,
		},
		
		this.getMessagesFrom = function(mostRecentCachedTimestamp, rootIds, allMessages, channelName, followedIds, preserve, cb) {
			this.channelName = channelName;
			this.rootIds = rootIds; // don't know whether it's worth constructing a hashmap for this
			this.mostRecentCachedTimestamp = mostRecentCachedTimestamp;
			this.outputQueue = allMessages;
			
			if(mostRecentCachedTimestamp == null) {
				this.getInitialMessages(followedIds, preserve, cb);
			}
			else {
				this.getNewMessages(followedIds, preserve, cb);
			}
		},
		this.getInitialMessages = function(followedIds, preserve, cb) {
			var channelTag = "#" + this.channelName;
			var hashtagStream = createHashtagStream(channelTag);
			var channelStream = createChannelStream(this.channelName);
			var stream = many([hashtagStream, channelStream]);

			var self = this;
			pull(stream, pull.filter(function(msg) {
				return followedIds.includes(msg.value.author.toLowerCase());
			}), pull.filter(function(msg) {
				if(msg.value && msg.value.content && msg.value.content.channel && msg.value.content.channel == self.channelName) {
					return true;
				}

				// filter out false positives from ssb-query's loose text matching
				if(msg.value && msg.value.content && msg.value.content.text && msg.value.content.text.indexOf) {
					let acceptableHashtags = [channelTag + "\n", channelTag + " "];
					for(let hashtag of acceptableHashtags) {
						if(msg.value.content.text.indexOf(hashtag) != -1) {
							return true
						}
					}

					return false;
				}
			}), pull.drain(function(msg) {
				self.rootIds.push(msg.key);
				self.pushMessage(msg);
			}, function() {
				if(self.mostRecentCachedTimestamp) {
					self.getReplies(followedIds);
				}
				else {
					pull( // ugly hack to get the most recent message timestamp into mostRecentCachedTimestamp, even though we only look at backlinks here
						client.messagesByType({type: "post", reverse: true, limit: 1}),
						pull.drain(function (msg) {
							self.mostRecentCachedTimestamp = msg.value.timestamp;
						}, () => {})
					);
					
					self.getRepliesInitial(followedIds);
				}
			}));

			cb(this.outputStream, preserve);
		},
		this.pushMessage = function(newMsg) {
			this.idsInChannel[newMsg.value.author] = true;

			if(newMsg.value.timestamp > opts.gt && newMsg.value.timestamp < opts.lt) {
				requestBlobs(newMsg);
				debug("pushing message with key " + newMsg.key);
				this.outputQueue.push(newMsg);
			}
		},
		this.finish = function() {
			this.outputQueue.sort((msg1, msg2) => (msg1.value.timestamp > msg2.value.timestamp ? -1 : 1));
			debug("done sorting messages");

			memoryCache[this.channelName] = this.outputQueue;
			for(var msg of this.outputQueue) {
				this.outputStream.push(msg);
			}

			if(this.outputQueue.length) {
				fs.writeFile(path.join(CACHE_FILEPATH, this.channelName + ".txt"), JSON.stringify({"root": this.rootIds, "allMessages": memoryCache[this.channelName], "mostRecentCachedTimestamp": this.mostRecentCachedTimestamp}), (error) => {
					if(error) {
						debug("[ERROR] Failed writing to message cache: " + error);
					}
					else {
						debug("Successfully saved messages to " + path.join(CACHE_FILEPATH, this.channelName + ".txt"));
					}
				});
			}
			
			updateBlobsFile();

			this.outputStream.end()
		},
		this.getNewMessages = function(followedIds, preserve, cb) {
			var stream = client.messagesByType({type: "post", gt: this.mostRecentCachedTimestamp})
			debug("looking for new messages");
			
			var self = this;
			pull(
				stream, 
				pull.filter(function(msg) {
					debug("filtering message " + JSON.stringify(msg));
					self.mostRecentCheckedTimestamp = msg.value.timestamp;
					return followedIds.includes(msg.value.author.toLowerCase());
				}),
				pull.filter(function(msg) { // assume all messages have msg.value.content, otherwise they wouldn't have post type
					if((msg.value.content.text && (msg.value.content.text.indexOf("#" + self.channelName + "\n") != -1 || msg.value.content.text.indexOf("#" + self.channelName + " ") != -1)) || msg.value.content.channel == self.channelName) {
						debug("found new root message: " + JSON.stringify(msg));
						self.rootIds.push(msg.key);
						return true;
					}
					else if(msg.value.content.root && self.rootIds.includes(msg.value.content.root)) {
						debug("found new reply: " + JSON.stringify(msg));
						return true;
					}
					
					return false;
				}),
				pull.drain(function(msg) {
					debug("found new message: " + JSON.stringify(msg));
					self.pushMessage(msg);
				}, self.finish.bind(self))
			);
			
			cb(this.outputStream, preserve);
		},
		this.getReplies = function(followedIds) {
			var stream = client.messagesByType({type: "post", gt: this.mostRecentCachedTimestamp})
			debug("looking for replies");
			
			var self = this;
			pull(
				stream, 
				pull.filter(function(msg) { // assume all messages have msg.value.content, otherwise they wouldn't have post type
					debug("filtering message " + JSON.stringify(msg));
					self.mostRecentCheckedTimestamp = msg.value.timestamp;
					return (!msg.value.content.text || msg.value.content.text.indexOf("#" + self.channelName) == -1) && msg.value.content.channelName != self.channelName && followedIds.includes(msg.value.author.toLowerCase());
				}),
				pull.filter(function(msg) {
					return msg.value.content.root && self.rootIds.includes(msg.value.content.root);
				}),
				pull.drain(function(msg) {
					debug("found new reply: " + JSON.stringify(msg));
					self.outputQueue.push(msg);
				}, self.finish.bind(self))
			);
		},
		this.getRepliesInitial = function(followedIds) {
			var backlinkStreams = [];
			debug("creating backlink streams");
			for(const key in this.rootIds) {
				backlinkStreams.push(getBacklinkStream(key));
			}

			var self = this;
			var channelTag = "#" + this.channelName;
			debug("looking for backlinked messages...");
			pull(
				many(backlinkStreams),
				pull.filter(function(msg) {
					debug("checking backlinked message " + JSON.stringify(msg));
					return msg.value && msg.value.content && msg.value.content.text && (msg.value.content.text.indexOf(channelTag) == -1) && !(msg.value.content.channelName == self.channelName) && (followedIds.includes(msg.value.author.toLowerCase()));
				}),
				pull.filter(function(msg) {
					debug("found backlink message: " + JSON.stringify(msg));
					return (msg.value.timestamp > self.opts.gt) && (msg.value.timestamp < self.opts.lt);
				}),
				pull.drain(function(msg) {
					debug("backlink message had correct timestamps: " + JSON.stringify(msg));
					self.outputQueue.push(msg);
				}, self.finish.bind(self))
			);
		}
	}
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

function getProfilePicturesOf(relevantIds) {
	let profilePictureStreams = []
	let profilePictureFound = {};

	for(let userId of relevantIds) {
		profilePictureFound[userId] = false;
		profilePictureStreams.push(createMetadataStream(userId));
	}
	let collectedStream = many(profilePictureStreams);

	if(relevantIds.length == 0) { // avoid the edge case where checkIfDone is never called
		// exit(cb, preserve);
		return;
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
		})
	);
}

function getBlob(blobId) {
	debug("Ensuring existence of blob with ID " + blobId);
	if(!(blobId in allowedBlobs)) {
		allowedBlobs.push(blobId);
	}
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

function debug(message) {
	if(DEBUG) {
		var timestamp = new Date();
		console.log("[channels-lib] [" + timestamp.toISOString() + "] " +  message);
	}
}

function getBacklinkStream(msgId) {
	var q = {
		dest: msgId,
		reverse: true,
		values: true
	}

	return client.links(q);
}

function createHashtagStream(channelName) {
	var search = client.search && client.search.query;
	debug("search: " + client.search);
	debug("query: " + client.search.query);
        if(!search) {
                console.log("[FATAL] ssb-search plugin must be installed to use channels");
                process.exit(5);
        }

        var query = search({
                query: channelName
        });

	return query;
}

function createChannelStream(channelName) {
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

	query.streamName = "channel";

	return query;
}

function createHashtagStreamOld(channelName) {
	var query = client.query.read({
		"$filter": {
			value: {
				content: {
					text: channelName
				}
			}
		}
	});

	query.streamName = "hashtag";

	return query;
}

function createUserStream(userId) {
	var query = client.createUserStream({
		id: userId
	});

	return query;
}

function createMetadataStream(userId) {
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

function getConfig() {
	return {
		host: config.host || "localhost",
		port: config.port || 8008
	}
}

function ensureFiles() {
	for(let path of PATHS) {
		if (!fs.existsSync(path)) {
			debug("no" + path + " directory detected, creating it...");
			fs.mkdirSync(path);
		}
	}
	
	for(let file of FILES) {
		if (!fs.existsSync(file)) {
			debug("no " + file + " file detected, creating it...");
			fs.writeFileSync(file);
		}
	}
}

function readAllowedBlobs() {
	let contents = fs.readFileSync(SBOT_BLOBS_FILE, "utf8");
	return contents.split("\n"); // this could cause slowdowns if the metadata file is several gigabytes, but i don't forsee that happening
}

function updateBlobsFile() {
	fs.writeFile(SBOT_BLOBS_FILE, allowedBlobs.join("\n"), {encoding: 'utf8'}, () => {});
}

module.exports = {
	getMessages: function(ssbClient, channelName, ssbOpts, preserve, cb, hops=MAX_HOPS) {
		client = ssbClient;
		debug("getting messages from #" + channelName);

		if(channelName in memoryCache && 'lt' in ssbOpts) {
			debug("already fetched messages from this channel");
			let outputStream = Pushable();
			ssbOpts = ssbOpts || DEFAULT_OPTS
			// let limit = ssbOpts.limit || 10
			let limit = 100; // this is the largest possible limit by default; since patchfoo doesn't pass limit to us by default, this is a (relatively) safe option
			debug("getting with limit " + limit);

			for(let msg of memoryCache[channelName]) {
				if(msg.value.timestamp < ssbOpts.lt) {
					outputStream.push(msg);
					limit -= 1;
					if(limit == 0) {
						break;
					}
				}
				if(msg.value.timestamp <= ssbOpts.gt) { // if we found a message that's too old, all the following messages will be too old as well
					break;
				}
			}

			cb(outputStream, preserve);
		}
		else {
			var mostRecentCachedTimestamp = null;
			var rootIds = [];
			var allMessages = [];
			if (fs.existsSync(path.join(CACHE_FILEPATH, channelName + ".txt"))) {
				cache = JSON.parse(fs.readFileSync(path.join(CACHE_FILEPATH, channelName + ".txt")));
				if (cache.root.length) {
					mostRecentCachedTimestamp = cache.mostRecentCachedTimestamp;
					rootIds = cache.root;
					allMessages = cache.allMessages;
					debug("successfully read messages from cache");
				}
				else {
					debug("[WARNING] Cache was empty!")
				}
				debug("most recent cached timestamp: " + mostRecentCachedTimestamp);
			}

			client.friends.hops({
				dunbar: Number.MAX_SAFE_INTEGER,
				max: hops
			}, function(error, friends) {
				if(error) {
					throw "Couldn't get a list of friends from scuttlebot:\n" + error;
				}

				var followedIds = Object.keys(friends).map(id => id.toLowerCase());
				let controller = new ChannelController(ssbOpts || DEFAULT_OPTS);
				controller.getMessagesFrom(mostRecentCachedTimestamp, rootIds, allMessages, channelName, followedIds, preserve, cb);
			});
		}
	}
}
