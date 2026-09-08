export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTokenRefresh } = await import("./lib/genesys/client");
    
    // Skip token refresh if Genesys credentials not configured
    if (!process.env.GC_CLIENT_CRED_CLIENT_ID || !process.env.GC_ENVIRONMENT) {
      console.warn("⚠️  Genesys Cloud credentials not configured - skipping token refresh");
      return;
    }
    
    console.log("🚀 Initializing Genesys Cloud token refresh...");
    try {
      await initTokenRefresh();
    } catch (error) {
      console.error("❌ Failed to initialize Genesys token:", error.message);
    }
  }
}
