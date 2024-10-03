import express from "express";
import cors from "cors";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";
import busboy from "busboy";

export const handler = async (event, context) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: event.headers });
    let buffer;
    let filename;

    bb.on("file", (fieldname, file, info) => {
      const chunks = [];
      filename = info.filename;

      file.on("data", (data) => {
        chunks.push(data);
      });

      file.on("end", () => {
        buffer = Buffer.concat(chunks);
      });
    });

    bb.on("finish", async () => {
      try {
        if (!buffer) {
          throw new Error("No file data received");
        }

        console.log("Buffer length:", buffer.length);
        console.log("Original filename:", filename);

        const fileTypeResult = await fileTypeFromBuffer(buffer);
        console.log("fileTypeResult:", fileTypeResult);

        let contentType;
        let fileExtension;

        if (fileTypeResult) {
          contentType = fileTypeResult.mime;
          fileExtension = fileTypeResult.ext;
        } else {
          // Fallback to using the file extension from the filename
          fileExtension = path.extname(filename).slice(1).toLowerCase();
          switch (fileExtension) {
            case "jpg":
            case "jpeg":
              contentType = "image/jpeg";
              break;
            case "png":
              contentType = "image/png";
              break;
            case "webp":
              contentType = "image/webp";
              break;
            default:
              contentType = "application/octet-stream";
          }
        }

        console.log("Detected Content-Type:", contentType);
        console.log("File Extension:", fileExtension);

        const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedMimeTypes.includes(contentType)) {
          throw new Error(`Unsupported file type: ${contentType}`);
        }

        console.log("Buffer preview:", buffer.toString("hex").slice(0, 50));

        const hash = crypto
          .createHash("md5")
          .update(buffer)
          .digest("hex")
          .slice(0, 10);
        console.log("Generated hash:", hash);

        const originalName = path.parse(filename).name;
        const s3Key = `${originalName}_${hash}.${fileExtension}`;
        console.log("S3 Key:", s3Key);

        const s3Client = new S3Client();
        const putObjectCommand = new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: contentType,
        });

        console.log("Sending PutObjectCommand to S3");
        const s3Result = await s3Client.send(putObjectCommand);
        console.log("S3 upload result:", s3Result);

        const s3ObjectUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`;
        console.log("S3 Object URL:", s3ObjectUrl);

        const dynamoClient = new DynamoDBClient();
        const putItemCommand = new PutItemCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Item: {
            ImageHash: { S: hash },
            S3ObjectUrl: { S: s3ObjectUrl },
            OriginalFileName: { S: filename },
            MimeType: { S: contentType },
          },
        });

        const dynamoResult = await dynamoClient.send(putItemCommand);
        console.log("DynamoDB result:", dynamoResult);

        resolve({
          statusCode: 200,
          body: JSON.stringify({
            result: "Image processed and saved successfully",
            fileType: contentType,
            fileSize: buffer.length,
            s3ObjectUrl: s3ObjectUrl,
            originalFileName: filename,
          }),
        });
      } catch (error) {
        console.error("Error processing image:", error);
        resolve({
          statusCode: 500,
          body: JSON.stringify({
            error: "Internal server error",
            details: error.message,
          }),
        });
      }
    });

    bb.write(event.body);
    bb.end();
  });
};
