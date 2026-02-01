// Compatibility shim: redirect to compiled TypeScript entry point
// For development, use: npm run dev
// For production, use: npm run build && npm run start

console.log('[KaijuanBoot] Loading from index.js compatibility shim');
console.log('[KaijuanBoot] Note: For development, use "npm run dev" instead');
console.log('[KaijuanBoot] For production, use "npm run build && npm run start"');

// Load compiled TypeScript entry point
require('./dist/index.js');
