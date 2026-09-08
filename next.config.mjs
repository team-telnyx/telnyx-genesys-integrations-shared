function configuredPublicHostname() {
  try {
    return new URL(process.env.GC_PUBLIC_BASE_URL || "").hostname || null;
  } catch {
    return null;
  }
}

const configuredHostname = configuredPublicHostname();
const genesysFrameAncestors = [
  "https://*.pure.cloud",
  "https://*.mypurecloud.com",
  "https://*.mypurecloud.ie",
  "https://*.mypurecloud.de",
  "https://*.mypurecloud.jp",
  "https://*.mypurecloud.com.au",
  "https://*.mypurecloud.ca",
  "https://*.mypurecloud.com.br",
].join(" ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "localhost:3000",
    "localhost:4000",
    ...(configuredHostname ? [configuredHostname] : []),
  ],
  async headers() {
    return [
      {
        source: "/genesys/widget-admin",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${genesysFrameAncestors}`,
          },
        ],
      },
      {
        source: "/widget/v1/loader.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
