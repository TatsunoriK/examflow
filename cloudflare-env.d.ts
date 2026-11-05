declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PROCTORING_API_URL?: string;
    PROCTORING_API_TOKEN?: string;
  }
}
