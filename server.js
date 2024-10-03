import express from "express";
import cors from "cors";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";
import busboy from "busboy";

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "..." : str;
}

export const handler = async (event, context) => {
  console.log("Received event:", truncate(JSON.stringify(event), 200));

  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: event.headers });
    let buffer;
    let filename;

    bb.on("file", (fieldname, file, info) => {
      filename = info.filename;
      console.log("Processing file:", filename);

      const chunks = [];
      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        buffer = Buffer.concat(chunks);
        console.log("File size:", buffer.length);
        console.log("File signature:", buffer.slice(0, 8).toString("hex"));
      });
    });

    bb.on("finish", async () => {
      try {
        if (!buffer) {
          throw new Error("No file data received");
        }

        console.log("Buffer type:", typeof buffer);
        console.log("Buffer is Buffer?", Buffer.isBuffer(buffer));
        console.log("Buffer length:", buffer.length);
        console.log("First 16 bytes:", buffer.slice(0, 16).toString("hex"));

        const fileTypeResult = await fileTypeFromBuffer(buffer);
        console.log(
          "Detected file type:",
          fileTypeResult ? fileTypeResult.mime : "unknown"
        );

        let contentType;
        let fileExtension;

        if (fileTypeResult) {
          contentType = fileTypeResult.mime;
          fileExtension = fileTypeResult.ext;
        } else {
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
              throw new Error(`Unsupported file type: ${fileExtension}`);
          }
        }

        console.log("Content-Type:", contentType);

        const hash = crypto
          .createHash("md5")
          .update(buffer)
          .digest("hex")
          .slice(0, 10);

        const originalName = path.parse(filename).name;
        const s3Key = `${originalName}_${hash}.${fileExtension}`;
        console.log("S3 Key:", s3Key);

        if (!Buffer.isBuffer(buffer)) {
          throw new Error("Invalid buffer object");
        }

        const s3Client = new S3Client();
        const putObjectCommand = new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: contentType,
        });

        console.log("Uploading to S3...");
        const s3Result = await s3Client.send(putObjectCommand);
        console.log("S3 upload successful");

        const s3ObjectUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`;

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

        console.log("Saving to DynamoDB...");
        await dynamoClient.send(putItemCommand);
        console.log("DynamoDB save successful");

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
        console.error("Error processing image:", error.message);
        resolve({
          statusCode: 500,
          body: JSON.stringify({
            error: "Internal server error",
            details: error.message,
          }),
        });
      }
    });

    let body = event.body;
    if (event.isBase64Encoded) {
      body = Buffer.from(event.body, "base64");
    }
    bb.write(body);
    bb.end();
  });
};
