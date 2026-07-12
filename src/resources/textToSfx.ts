import type { SoniloClient } from "../client.js";
import type { SfxResult, SfxTask, TextToSfxParams, WaitOptions } from "../types.js";

export class TextToSfx {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: TextToSfxParams): Promise<SfxTask> {
    const form = new FormData();
    form.set("prompt", params.prompt);
    form.set("duration", String(params.duration));
    if (params.audioFormat !== undefined) form.set("audio_format", params.audioFormat);
    const res = await this.client.request("/v1/text-to-sfx", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: TextToSfxParams, opts?: WaitOptions): Promise<SfxResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait(task.task_id, opts);
  }
}
