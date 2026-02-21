/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Required: native Node modules and mem0ai — keep out of webpack bundling
  serverExternalPackages: ["better-sqlite3", "mem0ai", "sqlite3"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Force mem0ai (workspace-linked package) to remain external at runtime
      // serverExternalPackages doesn't catch workspace symlinks, so we add
      // an explicit externals entry to prevent webpack from bundling mem0ai/oss
      const existingExternals = config.externals ?? [];
      const extraExternals = ({ request }, callback) => {
        // Keep workspace-linked packages and their deep deps out of webpack bundle
        if (
          request === "mem0ai" || request === "mem0ai/oss" || request?.startsWith("mem0ai/") ||
          request === "neo4j-driver" || request?.startsWith("neo4j-driver/")
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };
      config.externals = Array.isArray(existingExternals)
        ? [...existingExternals, extraExternals]
        : [existingExternals, extraExternals];
    } else {
      // Don't bundle server-only modules on the client side
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
      };
    }
    return config;
  },
}

export default nextConfig