import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { FRAME_JSON, FRAME_MIC, FRAME_SPEAKER, FrameParser, encodeFrame, encodeJson, type ClientMessage, type DaemonMessage } from "./wire.ts";

/** A TypeScript client for the daemon; the CLI's `status`/`say` and tests use it. */
export class DaemonClient extends EventEmitter<{ message: [DaemonMessage]; audio: [Buffer]; close: []; error: [Error] }> {
  private socket: Socket | undefined;
  private readonly parser = new FrameParser();

  constructor(private readonly socketPath: string) {
    super();
  }

  connect(hello: { pid: number; audio?: boolean } = { pid: process.pid }): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      socket.once("connect", () => {
        this.sendJson({ type: "hello", pid: hello.pid, audio: hello.audio ?? false });
        resolve();
      });
      socket.once("error", (e) => {
        this.emit("error", e);
        reject(e);
      });
      socket.on("data", (chunk: Buffer) => {
        for (const f of this.parser.push(chunk)) {
          if (f.type === FRAME_JSON) {
            try {
              this.emit("message", JSON.parse(f.payload.toString("utf8")) as DaemonMessage);
            } catch {
              // ignore malformed
            }
          } else if (f.type === FRAME_SPEAKER) this.emit("audio", Buffer.from(f.payload));
        }
      });
      socket.on("close", () => this.emit("close"));
    });
  }

  sendJson(message: ClientMessage): void {
    this.socket?.write(encodeJson(message));
  }

  sendMic(pcm: Buffer): void {
    this.socket?.write(encodeFrame(FRAME_MIC, pcm));
  }

  close(): void {
    this.socket?.destroy();
  }
}
