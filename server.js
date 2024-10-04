import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { parse } from "lambda-multipart-parser";
import path from "path";

// Use environment variables
const s3BucketName = process.env.S3_BUCKET;
const dynamoDBTableName = process.env.DYNAMODB_TABLE;
const awsRegion = process.env.AWS_REGION || "us-east-2"; // Default to us-east-2 if not set

const s3Client = new S3Client({
  region: awsRegion,
  forcePathStyle: true, // Needed for correct URL formatting
});
const dynamoDBClient = new DynamoDBClient({ region: awsRegion });

const allowedOrigins = [
  "https://www.linkedin.com",
  "https://www.facebook.com",
  "https://www.twitter.com",
  "https://www.x.com",
  "https://www.instagram.com",
  "https://www.reddit.com",
];

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const origin = event.headers.origin || event.headers.Origin;
  const allowOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
      body: "",
    };
  }

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    console.log("Content-Type:", contentType);

    if (!contentType || !contentType.includes("multipart/form-data")) {
      console.error("Invalid or missing Content-Type header");
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": allowOrigin,
        },
        body: JSON.stringify({ error: "Invalid Content-Type" }),
      };
    }

    // Parse the multipart form data
    const result = await parse(event);

    if (!result.files || result.files.length === 0) {
      throw new Error("No files found in the request");
    }

    const file = result.files[0];
    const fileData = file.content;
    const fileName = file.filename;
    const mimeType = file.contentType;

    console.log(`File received: ${fileName}`);
    console.log(`File size: ${fileData.length} bytes`);
    console.log(`Content-Type: ${mimeType}`);
    console.log(`First 16 bytes: ${fileData.slice(0, 16).toString("hex")}`);

    // Compute SHA-256 hash
    const sha256Hash = crypto
      .createHash("sha256")
      .update(fileData)
      .digest("hex");
    console.log(`Received image SHA-256 hash: ${sha256Hash}`);

    // Compute MD5 hash for S3 key
    const md5Hash = crypto
      .createHash("md5")
      .update(fileData)
      .digest("hex")
      .slice(0, 10);

    const fileExtension = path.extname(fileName || "");
    const s3Key = `${md5Hash}${fileExtension}`;

    console.log("Uploading to S3...");
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3BucketName,
        Key: s3Key,
        Body: fileData,
        ContentType: mimeType,
      })
    );
    console.log("S3 upload successful");

    const s3ObjectUrl = `https://${s3BucketName}.s3.${awsRegion}.amazonaws.com/${s3Key}`;

    console.log("Saving to DynamoDB...");
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: dynamoDBTableName,
        Item: {
          ImageHash: { S: md5Hash }, // Changed from imageHash to ImageHash
          s3ObjectUrl: { S: s3ObjectUrl },
          uploadDate: { S: new Date().toISOString() },
          sha256Hash: { S: sha256Hash },
        },
      })
    );
    console.log("DynamoDB save successful");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: JSON.stringify({
        message: "Image uploaded successfully",
        imageHash: md5Hash,
        s3ObjectUrl: s3ObjectUrl,
        sha256Hash: sha256Hash,
      }),
    };
  } catch (error) {
    console.error("Error processing image:", error);
    console.error("Error details:", JSON.stringify(error, null, 2));
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
    };
  }
};
