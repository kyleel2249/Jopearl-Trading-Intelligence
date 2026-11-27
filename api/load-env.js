import dotenv from 'dotenv';

// This side-effect module must be the first dependency imported by api/server.js.
// ESM evaluates dependencies before the importing module body, so calling dotenv.config()
// inside server.js would happen after its static dependencies had already captured process.env.
// Existing process variables retain precedence over both local files.
dotenv.config({ path: '.env.local', override: false });
dotenv.config({ path: '.env', override: false });
