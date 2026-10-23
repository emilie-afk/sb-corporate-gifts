// Where is this code running? Used to keep development conveniences (dev login, demo data) out of production.

/** True on Netlify (build or function), on AWS Lambda, or with NODE_ENV=production. */
export function isDeployedRuntime(env: NodeJS.ProcessEnv = process.env) {
  return !!(env.NETLIFY || env.CONTEXT || env.SITE_ID || env.AWS_LAMBDA_FUNCTION_NAME || env.NODE_ENV === "production");
}
