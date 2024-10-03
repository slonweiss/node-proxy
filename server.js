import express from "express";
import cors from "cors";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";
import multer from "multer";

// Export the app
export const app = express();

// Initialize CORS
app.use(cors());

// Define allowed MIME types
const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];

// Initialize S3 and DynamoDB clients
const s3Client = new S3Client();
const dynamoClient = new DynamoDBClient();

// Configure multer for handling multipart/form-data
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

app.post("/analyze-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const buffer = req.file.buffer;
    const originalFilename = req.file.originalname || "unknown";
    const contentType = req.file.mimetype;

    console.log("Content-Type:", contentType);
    console.log("Original filename:", originalFilename);

    if (!contentType || !allowedMimeTypes.includes(contentType)) {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    console.log("Buffer length:", buffer.length);
    console.log("Buffer preview:", buffer.toString("hex").slice(0, 50));

    const fileExtension = path.extname(originalFilename).slice(1);

    const hash = crypto
      .createHash("md5")
      .update(buffer)
      .digest("hex")
      .slice(0, 10);
    console.log("Generated hash:", hash);

    const originalName = path.parse(originalFilename).name;
    const s3Key = `${originalName}_${hash}.${fileExtension}`;
    console.log("S3 Key:", s3Key);

    const putObjectCommand = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
    });

    const s3Result = await s3Client.send(putObjectCommand);
    console.log("S3 upload result:", s3Result);

    const s3ObjectUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`;
    console.log("S3 Object URL:", s3ObjectUrl);

    const putItemCommand = new PutItemCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        ImageHash: { S: hash },
        S3ObjectUrl: { S: s3ObjectUrl },
        OriginalFileName: { S: originalFilename },
        MimeType: { S: contentType },
      },
    });

    const dynamoResult = await dynamoClient.send(putItemCommand);
    console.log("DynamoDB result:", dynamoResult);

    res.json({
      result: "Image processed and saved successfully",
      fileType: contentType,
      fileSize: buffer.length,
      s3ObjectUrl: s3ObjectUrl,
      originalFileName: originalFilename,
    });
  } catch (error) {
    console.error("Error processing image:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

console.log("Server initialized and ready to handle requests");
