import type { SoniloClient } from "../client.js";
import type { AccountServices, UsageResponse } from "../types.js";

export class Account {
  constructor(private readonly client: SoniloClient) {}

  async services(): Promise<AccountServices> {
    const res = await this.client.request("/v1/account/services");
    return (await res.json()) as AccountServices;
  }

  async usage(params: { days?: number } = {}): Promise<UsageResponse> {
    const query = params.days !== undefined ? `?days=${params.days}` : "";
    const res = await this.client.request(`/v1/account/usage${query}`);
    return (await res.json()) as UsageResponse;
  }
}
