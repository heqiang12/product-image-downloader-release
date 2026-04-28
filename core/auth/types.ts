export interface PlatformAuthStatus {
  platform: string;
  name: string;
  loginUrl?: string;
  isLoggedIn: boolean;
  cookieCount: number;
  profilePartition: string;
  updatedAt?: number;
}

export interface StoredPlatformAuth {
  platform: string;
  isLoggedIn: boolean;
  cookieCount: number;
  updatedAt: number;
}
