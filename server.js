import express from "express";
import cors from "cors";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

export const handler = async (event, context) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    let buffer;
    let contentType;
    let originalFilename;

    if (event.isBase64Encoded) {
      buffer = Buffer.from(event.body, "base64");
      contentType = event.headers["content-type"];

      // Extract filename from content-disposition header if available
      const contentDisposition = event.headers["content-disposition"];
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
        originalFilename = filenameMatch ? filenameMatch[1] : "unknown";
      } else {
        originalFilename = "unknown";
      }
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Expected base64 encoded image data" }),
      };
    }

    console.log("Buffer length:", buffer.length);
    console.log("Original filename:", originalFilename);
    console.log("Content-Type:", contentType);

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!contentType || !allowedMimeTypes.includes(contentType)) {
      console.error("Unsupported file type:", contentType);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Unsupported file type" }),
      };
    }

    console.log("Buffer preview:", buffer.toString("hex").slice(0, 50));

    const fileExtension = path.extname(originalFilename).slice(1) || "jpg";
    const hash = crypto
      .createHash("md5")
      .update(buffer)
      .digest("hex")
      .slice(0, 10);
    console.log("Generated hash:", hash);

    const originalName = path.parse(originalFilename).name;
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
        OriginalFileName: { S: originalFilename },
        MimeType: { S: contentType },
      },
    });

    const dynamoResult = await dynamoClient.send(putItemCommand);
    console.log("DynamoDB result:", dynamoResult);

    return {
      statusCode: 200,
      body: JSON.stringify({
        result: "Image processed and saved successfully",
        fileType: contentType,
        fileSize: buffer.length,
        s3ObjectUrl: s3ObjectUrl,
        originalFileName: originalFilename,
      }),
    };
  } catch (error) {
    console.error("Error processing image:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
    };
  }
};
