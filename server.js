import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileTypeFromBuffer } from "file-type";
import { fileURLToPath } from "url";
import sanitize from "sanitize-filename";

// Export the app
export const app = express();

(async () => {
  // Define __dirname in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const receivedDir = path.join(__dirname, "received");

  // Ensure the received directory exists
  try {
    await fs.access(receivedDir);
  } catch {
    await fs.mkdir(receivedDir, { recursive: true });
  }

  // Initialize CORS
  app.use(cors());

  // Define allowed MIME types
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];

  // File filter to accept only specific image types
  const fileFilter = (req, file, cb) => {
    console.log("Received file:", file);
    console.log("File mimetype:", file.mimetype);

    // Accept all files, we'll check the actual type later
    cb(null, true);
  };

  // Modify the storage configuration
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, receivedDir);
    },
    filename: function (req, file, cb) {
      const originalName = sanitize(file.originalname);
      const fileExtension = path.extname(originalName);
      const baseName = path.basename(originalName, fileExtension);
      const safeName = `${baseName}-${Date.now()}${fileExtension}`;

      console.log("Original filename:", file.originalname);
      console.log("Sanitized filename:", originalName);
      console.log("Safe name:", safeName);

      cb(null, safeName);
    },
  });

  // Initialize multer with storage, file filter, and size limit
  const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  });

  app.post("/analyze-image", upload.single("image"), async (req, res) => {
    console.log("Request received:", req.body);
    console.log("Files received:", req.files);
    console.log("File received:", req.file);

    try {
      if (!req.file) {
        throw new Error("No file uploaded");
      }

      // Read the file buffer
      const buffer = await fs.readFile(req.file.path);

      // Detect the file type using fileTypeFromBuffer
      const type = await fileTypeFromBuffer(buffer);

      console.log("Detected file type:", type);
      console.log("File size:", buffer.length);

      if (type && allowedMimeTypes.includes(type.mime)) {
        console.log("File type is supported:", type.mime);
      } else {
        console.warn(
          "Unsupported or undetected file type:",
          type ? type.mime : "unknown"
        );
      }

      // Respond back to the client
      res.json({
        result: "Image received and saved successfully",
        fileType: type ? type.mime : "unknown",
        fileSize: buffer.length,
      });
    } catch (error) {
      console.error("Error processing image:", error);
      res.status(400).json({ error: error.message });
    }
  });
})();
