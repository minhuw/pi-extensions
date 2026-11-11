// Sends DA1 and CPR to its terminal, collects every reply for a while, and prints them JSON-escaped.
process.stdin.setRawMode(true);
let replies = "";
process.stdin.on("data", chunk => { replies += chunk.toString("latin1"); });
process.stdout.write("\x1b[c\x1b[6n");
setTimeout(() => {
    process.stdout.write(`\r\nREPLIES=${JSON.stringify(replies)}\r\n`);
    process.exit(0);
}, Number(process.argv[2] ?? 1500));
