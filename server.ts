import express from "express";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import * as admin from "firebase-admin";
import { cert } from "firebase-admin";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import "dotenv/config";

// Configure Firebase Admin
// Zero-Config Initialization: Inherit project identity from the environment
if (getApps().length === 0) {
  try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (serviceAccount) {
      console.log("[Server] Initializing with provided Service Account...");
      const parsedCert = JSON.parse(serviceAccount);
      initializeApp({ credential: cert(parsedCert) });
    } else {
      console.log("[Server] Initializing with Default Environment Credentials...");
      initializeApp();
    }
  } catch (err: any) {
    console.error("[Server] Firebase Initialization Error:", err.message);
    // Final fallback for development
    initializeApp({ projectId: process.env.VITE_FIREBASE_PROJECT_ID });
  }
}

const db = getFirestore();

// Immediate connectivity check
(async () => {
  try {
    console.log("[Server] Testing Firestore connectivity...");
    const testSnap = await db.collection('settings').limit(1).get();
    console.log(`[Server] Firestore connected successfully. Found ${testSnap.size} settings docs.`);
  } catch (err: any) {
    console.error("[Server] FATAL: Firestore connection failed!");
    console.error(` - Error Code: ${err.code}`);
    console.error(` - Message: ${err.message}`);
    if (err.code === 5) {
      console.error(" - Hint: The database ID or Project ID might be incorrect. Check your environment variables.");
    }
  }
})();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Cloudinary Asset Deletion Helper
async function deleteCloudinaryAsset(publicId: string, resourceType: string = 'image') {
  try {
    console.log(`[Cloudinary] Background Cleanup: Deleting ${resourceType} ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return result.result === 'ok' || result.result === 'not found';
  } catch (error) {
    console.error(`[Cloudinary] Background Cleanup Failed for ${publicId}:`, error);
    return false;
  }
}

// Background Cleanup Logic
async function runAutomatedCleanup() {
  try {
    const now = new Date();
    console.log(`[Cleanup Service] Cycle started at: ${now.toISOString()}`);
    
    // 1. Get Settings for Cleanup Threshold
    let settings: any;
    try {
      const settingsSnap = await db.collection('settings').doc('global_config').get();
      if (!settingsSnap.exists) {
        console.log("[Cleanup Service] Global config not found. Skipping.");
        return;
      }
      settings = settingsSnap.data();
    } catch (err: any) {
      console.error("[Cleanup Service] Firestore access error:", err.message);
      return;
    }
    
    const cleanupMinutes = settings?.cloudinaryCleanupMinutes || 60;
    const threshold = new Date(now.getTime() - (cleanupMinutes * 60 * 1000));
    
    console.log(`[Cleanup Service] Settings found. Cleanup Threshold: ${cleanupMinutes} minutes.`);
    console.log(`[Cleanup Service] Current Time: ${now.toISOString()}`);
    console.log(`[Cleanup Service] Threshold Time: ${threshold.toISOString()}`);

    // --- NEW: Active Media Cleanup ---
    // If active media exists and is older than the threshold, delete it.
    let activeMediaUploadedAt: Date | null = null;
    if (settings.heroMediaUploadedAt) {
      activeMediaUploadedAt = new Date(settings.heroMediaUploadedAt);
      console.log(`[Cleanup Service] heroMediaUploadedAt (parsed): ${activeMediaUploadedAt.toISOString()}`);
    } else if (settings.updatedAt) {
      // Fallback for legacy data that doesn't have heroMediaUploadedAt yet
      activeMediaUploadedAt = typeof settings.updatedAt.toDate === 'function' 
        ? settings.updatedAt.toDate() 
        : new Date(settings.updatedAt);
      console.log(`[Cleanup Service] Using updatedAt fallback (parsed): ${activeMediaUploadedAt.toISOString()}`);
    } else {
      console.log(`[Cleanup Service] WARNING: No timing fields (heroMediaUploadedAt or updatedAt) found in global_config.`);
    }

    if (activeMediaUploadedAt && !isNaN(activeMediaUploadedAt.getTime())) {
      const isExpired = activeMediaUploadedAt < threshold;
      console.log(`[Cleanup Service] Active Media Age Check: ${isExpired ? 'EXPIRED' : 'NOT EXPIRED'}`);
      
      if (isExpired) {
        const assetsToClear = [];
        if (settings.heroImagePublicId) assetsToClear.push({ id: settings.heroImagePublicId, type: 'image' });
        if (settings.heroVideoPublicId) assetsToClear.push({ id: settings.heroVideoPublicId, type: 'video' });

        console.log(`[Cleanup Service] Found ${assetsToClear.length} assets to purge in active hero.`);
        console.log(`[Cleanup Service] >>> PURGING ACTIVE HERO MEDIA (Expired after ${cleanupMinutes}m)`);
        for (const asset of assetsToClear) {
          await deleteCloudinaryAsset(asset.id, asset.type);
        }

        // Reset the active banner media fields in Firestore
        await db.collection('settings').doc('global_config').update({
          heroImagePublicId: null,
          heroImageUrl: null,
          heroVideoPublicId: null,
          heroVideoUrl: null,
          heroMediaUploadedAt: null,
          heroBgType: 'image', // Reset to default
          lastAutomatedCleanup: now.toISOString(),
          cleanupStatus: 'active_media_purged'
        });
        console.log("[Cleanup Service] Success: Active Hero media cleared from settings.");
      }
    }

    // --- Existing: Rejected Updates Cleanup ---
    console.log(`[Cleanup Service] Filtering for rejected updates older than threshold...`);
    
    // 2. Query for Rejected Updates
    // We use a single field query to avoid composite index requirements
    let rejectedSnap;
    try {
      rejectedSnap = await db.collection('pending_updates')
        .where('status', '==', 'rejected')
        .get();
    } catch (queryErr: any) {
      console.error("[Cleanup Service] Query error:", queryErr.message);
      return;
    }
      
    console.log(`[Cleanup Service] Found ${rejectedSnap.size} rejected updates total.`);

    for (const doc of rejectedSnap.docs) {
      const data = doc.data();
      
      // Filter manually for 'settings' (Hero Banner Media) and check for assets
      if (data.type !== 'settings' || !data.assetToCleanup) continue;
      
      // Correctly handle Firestore Timestamps for the automated cleanup timer
      let resolvedAt: Date | null = null;
      if (data.resolvedAt) {
        if (typeof data.resolvedAt.toDate === 'function') {
          resolvedAt = data.resolvedAt.toDate();
        } else {
          resolvedAt = new Date(data.resolvedAt);
        }
      }
      
      // Only cleanup if the rejection happened before the threshold
      if (resolvedAt && !isNaN(resolvedAt.getTime()) && resolvedAt < threshold) {
        const asset = data.assetToCleanup;
        if (asset && asset.publicId) {
          console.log(`[Cleanup Service] >>> PURGING STALE HERO ASSET: ${asset.publicId} (${asset.resourceType})`);
          
          const success = await deleteCloudinaryAsset(asset.publicId, asset.resourceType || 'image');
          
          if (success) {
            // Update document to prevent repeated cleanup attempts
            await doc.ref.update({ 
              assetToCleanup: null,
              lastAutomatedCleanup: now.toISOString(),
              cleanupStatus: 'purged'
            });
            console.log(`[Cleanup Service] Success: Asset ${asset.publicId} removed from Cloudinary.`);
          }
        }
      } else {
        const remaining = resolvedAt ? Math.round((resolvedAt.getTime() - threshold.getTime()) / 60000) : 'unknown';
        console.log(`[Cleanup Service] Skipping update ${doc.id}: Not old enough yet (approx ${remaining} mins remaining).`);
      }
    }
    console.log("[Cleanup Service] Cycle finished.");
  } catch (err: any) {
    console.error("[Cleanup Service] Critical error:", err.message);
  }
}

// Start Background Task (runs every 60 seconds)
setInterval(runAutomatedCleanup, 60 * 1000);

// Global error handlers
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Server] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught Exception:", err);
  process.exit(1);
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route: Delete Cloudinary Asset
  app.post("/api/cloudinary/delete", async (req, res) => {
    const { publicId, resourceType } = req.body;

    if (!publicId) {
      return res.status(400).json({ error: "Missing publicId" });
    }

    try {
      console.log(`[Cloudinary] Attempting to delete asset: ${publicId} (Type: ${resourceType || 'image'})`);
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' });
      
      if (result.result === 'ok' || result.result === 'not found') {
        return res.json({ success: true, result });
      } else {
        return res.status(500).json({ error: "Cloudinary deletion failed", detail: result });
      }
    } catch (error: any) {
      console.error("[Cloudinary] Deletion error:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    console.log(`[Server] Serving static files from: ${distPath}`);
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      res.sendFile(indexPath);
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Success: Listening on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer();
