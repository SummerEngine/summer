import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { probe } from "./media.js";

describe("content.make display geometry", () => {
  it.each([
    [undefined, 96, 160],
    [0, 96, 160],
    [90, 160, 96],
    [-90, 160, 96],
    [180, 96, 160],
  ])("reads the displayed dimensions for a stream rotated %s degrees", async (rotation, width, height) => {
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        const sideData = rotation === undefined ? [] : [{ side_data_type: "Display Matrix", rotation }];
        child.stdout.end(JSON.stringify({
          streams: [{ codec_type: "video", width: 96, height: 160, avg_frame_rate: "30/1", side_data_list: sideData }, { codec_type: "audio" }],
          format: { duration: "0.6" },
        }));
        child.emit("close", 0);
      });
      return child;
    });
    const info = await probe("gameplay.mp4");
    expect(spawn).toHaveBeenLastCalledWith("ffprobe", expect.arrayContaining([expect.stringContaining("stream_side_data=rotation")]), expect.anything());
    expect(info).toEqual({ width, height, duration: 0.6, fps: 30, hasAudio: true });
  });
});
