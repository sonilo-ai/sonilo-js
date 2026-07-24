import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "db1", status: "processing" };

function ackClient() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(ACK, 202),
  );
  return { fetch, client: new SoniloClient({ apiKey: "k", fetch }) };
}

describe("dubbing", () => {
  it("posts video_url and languages as a JSON array string to /v1/dubbing", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      languages: ["es", "fr"],
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/dubbing");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(JSON.parse(form.get("languages") as string)).toEqual(["es", "fr"]);
    expect(form.has("video")).toBe(false);
  });

  it("omits languages when unset so the server default applies", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("languages")).toBe(false);
  });

  it("uploads a File as the video part", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ video: new File(["bytes"], "clip.mp4") });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.has("video_url")).toBe(false);
  });

  it("rejects a non-https videoUrl before sending anything", async () => {
    const { fetch, client } = ackClient();
    await expect(
      client.dubbing.submit({ videoUrl: "http://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when both or neither of video and videoUrl are given", async () => {
    const { client } = ackClient();
    await expect(
      client.dubbing.submit({ video: new Blob(["x"]), videoUrl: "https://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.dubbing.submit({})).rejects.toBeInstanceOf(SoniloError);
  });

  it("passes an unknown language code through for the server to reject", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", languages: ["xx"] });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("languages") as string)).toEqual(["xx"]);
  });

  it("generate() polls to a DubbingResult carrying one URL per language", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "db1",
          type: "dubbing",
          status: "succeeded",
          outputs: { es: "https://r2/es.mp4", fr: "https://r2/fr.mp4" },
          cost: 1.5,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.dubbing.generate(
      { videoUrl: "https://x/v.mp4", languages: ["es", "fr"] },
      { pollInterval: 0 },
    );
    expect(res.outputs).toEqual({
      es: "https://r2/es.mp4",
      fr: "https://r2/fr.mp4",
    });
    expect(res.cost).toBe(1.5);
  });
});
