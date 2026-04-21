// Centralized env-backed constants for scripts.

import './_dotenv-loader.mjs';

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
