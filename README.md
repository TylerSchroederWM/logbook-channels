# logbook-channels

logbook-channels is a utility to unify the two ways of adding messages to channels in Scuttlebutt: hashtags and channel headers.

The files in the repo are as follows:
- **pull-many-v2.js** is a utility that must be in the same directory as either *channels-v2.js* or *channels-lib.js*.
- **channels-v2.js** is a standalone command line utility. To print all messages in the `logbook` channel, run `node channels-v2.js logbook`.
- **channels-lib.js** provides channel messages from a pull-stream. Example usage would be:

```
const pull = require("pull-stream");
const clientFactory = require("ssb-client");
const channels = require("./channels-lib");

clientFactory(function(err, client) {
  if(err) throw err;
  channel.getMessages(client, "logbook", function(messageStream) {
    pull(messageStream, pull.drain(function(msg) {
      console.log(JSON.stringify(msg));
    })
  });
});
```
