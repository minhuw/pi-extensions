// Reports OSC 7501 program states, one per input line (`working`, `blocked <message>`, `idle`, `error`, `clear`, `exit`).
import { createInterface } from "node:readline";
const osc = payload => process.stdout.write(`\x1b]7501;${payload}\x1b\\`);
process.stdout.write("status fixture ready\r\n");
for await (const line of createInterface({ input: process.stdin })) {
    const [state, ...rest] = line.trim().split(" ");
    if (state === "exit") process.exit(0);
    const message = rest.length ? `:kind=question:msg=${Buffer.from(rest.join(" ")).toString("base64")}` : "";
    osc(`state=${state}:app=pi${message}`);
    process.stdout.write(`ok ${state}\r\n`);
}
