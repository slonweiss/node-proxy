import express from "express";
import cors from "cors";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

// Export the app
export const app = express();

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

// Use memory storage instead of disk storage
const storage = multer.memoryStorage();

// Initialize multer with memory storage, file filter, and size limit
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Initialize S3 and DynamoDB clients
const s3Client = new S3Client();
const dynamoClient = new DynamoDBClient();

app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    console.log("Received file:", req.file);

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const buffer = req.file.buffer;
    console.log("Buffer length:", buffer.length);
    console.log("Buffer preview:", buffer.toString("hex").slice(0, 50));

    // Detect the file type using fileTypeFromBuffer
    let type = await fileTypeFromBuffer(buffer);
    console.log("Detected file type:", type);

    // If file type detection fails, use the MIME type provided by multer
    if (!type) {
      console.log("File type detection failed. Using MIME type from multer.");
      type = {
        mime: req.file.mimetype,
        ext: req.file.mimetype.split("/")[1],
      };
    }

    console.log("Final file type:", type);

    if (!allowedMimeTypes.includes(type.mime)) {
      console.log("Allowed MIME types:", allowedMimeTypes);
      console.log("Uploaded file MIME type:", type.mime);
      return res.status(400).json({ error: "Unsupported file type" });
    }

    // Generate a unique hash for the file
    const hash = crypto
      .createHash("md5")
      .update(buffer)
      .digest("hex")
      .slice(0, 10);
    console.log("Generated hash:", hash);

    // Preserve original filename and add hash
    const originalName = path.parse(req.file.originalname).name;
    const fileExtension = type.ext;
    const s3Key = `${originalName}_${hash}.${fileExtension}`;
    console.log("S3 Key:", s3Key);

    // Upload to S3
    const putObjectCommand = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: type.mime,
    });

    const s3Result = await s3Client.send(putObjectCommand);
    console.log("S3 upload result:", s3Result);

    const s3ObjectUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`;
    console.log("S3 Object URL:", s3ObjectUrl);

    // Write to DynamoDB
    const putItemCommand = new PutItemCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        ImageHash: { S: hash },
        S3ObjectUrl: { S: s3ObjectUrl },
        OriginalFileName: { S: req.file.originalname },
      },
    });

    const dynamoResult = await dynamoClient.send(putItemCommand);
    console.log("DynamoDB result:", dynamoResult);

    // Respond back to the client
    res.json({
      result: "Image processed and saved successfully",
      fileType: type.mime,
      fileSize: buffer.length,
      s3ObjectUrl: s3ObjectUrl,
      originalFileName: req.file.originalname,
    });
  } catch (error) {
    console.error("Error processing image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

console.log("Server initialized and ready to handle requests");
