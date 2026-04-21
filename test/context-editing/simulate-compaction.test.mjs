import { ContextCurator } from '../../dist/middlewares/context-editing/ContextCurator.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG } from '../../dist/middlewares/context-editing/config.js';

const curator = new ContextCurator();

const dummyTranscript = `
System: You are a helpful AI coding assistant.
User: We need to build a new microservice for the payment gateway.
Assistant: I can help with that. What port should it run on?
User: Let's run it on port 3000.
Assistant: Got it. I'll configure the server.
TODO: Setup express server on port 3000
User: Actually, wait. The requirement changed.
Instead of using 3000, use 8080.
Assistant: Understood. Changing port to 8080.
User: Also, the new payment API endpoint is https://api.stripe.com/v1/payments and our secret is stored in process.env.STRIPE_SECRET_KEY.
MUST preserve the endpoint and secret for the deployment.
`;

// curate() is now async — no pluginApi passed, so regex fallback is used
const result = await curator.curate(dummyTranscript, DEFAULT_CONTEXT_EDITING_CONFIG.icc);
console.log("=== EXTRACTED ENTITIES ===");
console.log(result.extractedEntities);
console.log("\n=== CONFLICTS RESOLVED ===");
console.log(result.resolvedConflicts);
console.log("\n=== PRIORITY SEGMENTS ===");
console.log(result.prioritySegments);
console.log("\n=== FINAL INSTRUCTION PROMPT ===");
console.log(result.iccInstruction);
