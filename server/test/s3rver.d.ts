/** Minimal types for the s3rver test dependency (S3-compatible emulator; no signature validation). */
declare module 's3rver' {
  export default class S3rver {
    constructor(options: {
      port?: number;
      address?: string;
      directory: string;
      silent?: boolean;
      configureBuckets?: { name: string; configs?: unknown[] }[];
    });
    run(): Promise<unknown>;
    close(): Promise<void>;
  }
}
