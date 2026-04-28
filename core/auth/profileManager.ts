import type { PlatformAdapter } from '../platforms/types.js';
import type { PlatformAuthStatus, StoredPlatformAuth } from './types.js';

export class AuthProfileManager {
  private readonly states = new Map<string, StoredPlatformAuth>();

  constructor(initialStates: StoredPlatformAuth[] = []) {
    for (const state of initialStates) {
      this.states.set(state.platform, state);
    }
  }

  getPartition(platformId: string): string {
    return `persist:jd-image-downloader-${platformId}`;
  }

  getStatus(platform: PlatformAdapter): PlatformAuthStatus {
    const state = this.states.get(platform.id);

    return {
      platform: platform.id,
      name: platform.name,
      loginUrl: platform.loginUrl,
      isLoggedIn: Boolean(state?.isLoggedIn),
      cookieCount: state?.cookieCount || 0,
      profilePartition: this.getPartition(platform.id),
      updatedAt: state?.updatedAt,
    };
  }

  listStatuses(platforms: PlatformAdapter[]): PlatformAuthStatus[] {
    return platforms.map((platform) => this.getStatus(platform));
  }

  updateStatus(platform: PlatformAdapter, cookieNames: string[]): PlatformAuthStatus {
    const cookieNameSet = new Set(cookieNames);
    const authCookieGroups =
      platform.authCookieGroups ||
      (platform.authCookieNames?.length ? [platform.authCookieNames] : []);
    const isLoggedIn =
      authCookieGroups.length > 0
        ? authCookieGroups.some((group) =>
            group.every((cookieName) => cookieNameSet.has(cookieName)),
          )
        : cookieNames.length > 0;
    const state: StoredPlatformAuth = {
      platform: platform.id,
      isLoggedIn,
      cookieCount: cookieNames.length,
      updatedAt: Date.now(),
    };

    this.states.set(platform.id, state);
    return this.getStatus(platform);
  }

  clearStatus(platformId: string): void {
    this.states.delete(platformId);
  }

  toJSON(): StoredPlatformAuth[] {
    return Array.from(this.states.values());
  }
}
