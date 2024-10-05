import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { parse } from "lambda-multipart-parser";
import path from "path";
import imghash from "imghash";
import sharp from "sharp";

// Use environment variables
const s3BucketName = process.env.S3_BUCKET;
const dynamoDBTableName = process.env.DYNAMODB_TABLE;
const awsRegion = process.env.AWS_REGION || "us-east-2"; // Default to us-east-2 if not set

const s3Client = new S3Client({
  region: awsRegion,
  logger: console, // Enable AWS SDK logging
});

const dynamoDBClient = new DynamoDBClient({ region: awsRegion });

const allowedOrigins = [
  "https://www.linkedin.com",
  "https://www.facebook.com",
  "https://www.twitter.com",
  "https://www.x.com",
  "https://www.instagram.com",
  "https://www.reddit.com",
  "https://realeyes.ai",
];

// Utility function to convert stream to buffer
const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });

// Add this function after the streamToBuffer function
const calculatePHash = async (buffer) => {
  const resizedBuffer = await sharp(buffer)
    .resize(32, 32, { fit: "fill" })
    .grayscale()
    .toBuffer();
  return imghash.hash(resizedBuffer);
};

function getFileExtensionFromData(fileName, url, mimeType, fileData) {
  console.log(`Determining file extension for: ${fileName}`);
  console.log(`URL: ${url}`);
  console.log(`MIME type: ${mimeType}`);

  let extensionSource = "";
  let ext = "";

  // 1. Check original filename
  ext = path.extname(fileName).toLowerCase();
  if (ext && ext.length > 1) {
    extensionSource = "filename";
    console.log(`Extension derived from filename: ${ext}`);
    return { ext, extensionSource };
  }

  // 2. Check URL for format (Twitter-specific)
  if (url && url.includes("twimg.com")) {
    const urlObj = new URL(url);
    const format = urlObj.searchParams.get("format");
    if (format) {
      ext = `.${format.toLowerCase()}`;
      extensionSource = "URL format";
      console.log(`Extension derived from URL format: ${ext}`);
      return { ext, extensionSource };
    }
  }

  // 3. Examine file header (magic numbers)
  const header = fileData.slice(0, 12).toString("hex");
  if (header.startsWith("ffd8ffe0") || header.startsWith("ffd8ffe1")) {
    ext = ".jpg";
    extensionSource = "file header";
  } else if (header.startsWith("89504e470d0a1a0a")) {
    ext = ".png";
    extensionSource = "file header";
  } else if (
    header.startsWith("474946383961") ||
    header.startsWith("474946383761")
  ) {
    ext = ".gif";
    extensionSource = "file header";
  } else if (
    header.startsWith("52494646") &&
    header.slice(16, 24) === "57454250"
  ) {
    ext = ".webp";
    extensionSource = "file header";
  }

  if (ext) {
    console.log(`Extension derived from file header: ${ext}`);
    return { ext, extensionSource };
  }

  // 4. Fall back to MIME type
  const mimeToExt = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
  };
  ext = mimeToExt[mimeType] || "";
  extensionSource = ext ? "MIME type" : "default";
  console.log(`Extension derived from MIME type: ${ext || ".bin"}`);

  return { ext: ext || ".bin", extensionSource };
}

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
    let fileData = file.content;
    const fileName = file.filename;
    const mimeType = file.contentType;
    const url = file.url;

    console.log(`File received: ${fileName}`);
    console.log(`File size: ${fileData.length} bytes`);
    console.log(`Content-Type: ${mimeType}`);
    console.log(`First 16 bytes: ${fileData.slice(0, 16).toString("hex")}`);

    // Ensure fileData is a Buffer
    console.log(`Type of fileData: ${typeof fileData}`);
    console.log(`Is fileData a Buffer: ${Buffer.isBuffer(fileData)}`);
    if (!Buffer.isBuffer(fileData)) {
      fileData = Buffer.from(fileData, "binary");
    }

    // Calculate both hashes
    const sha256Hash = crypto
      .createHash("sha256")
      .update(fileData)
      .digest("hex");
    const pHash = await calculatePHash(fileData);

    console.log(`Received image SHA-256 hash: ${sha256Hash}`);
    console.log(`Calculated pHash: ${pHash}`);

    // Perform parallel checks
    const [exactDuplicate, similarImages] = await Promise.all([
      dynamoDBClient.send(
        new GetItemCommand({
          TableName: dynamoDBTableName,
          Key: {
            ImageHash: { S: sha256Hash },
          },
        })
      ),
      dynamoDBClient.send(
        new QueryCommand({
          TableName: dynamoDBTableName,
          IndexName: "PHashIndex",
          KeyConditionExpression: "PHash = :phash",
          ExpressionAttributeValues: {
            ":phash": { S: pHash },
          },
        })
      ),
    ]);

    if (exactDuplicate.Item) {
      console.log("Duplicate file detected");

      const updatedOriginWebsites = new Set(
        exactDuplicate.Item.originWebsites
          ? exactDuplicate.Item.originWebsites.SS
          : []
      );
      updatedOriginWebsites.add(origin);

      // Update DynamoDB with the new origin website and increment requestCount
      const updateResult = await dynamoDBClient.send(
        new UpdateItemCommand({
          TableName: dynamoDBTableName,
          Key: {
            ImageHash: { S: sha256Hash },
          },
          UpdateExpression:
            "SET originWebsites = :websites, requestCount = if_not_exists(requestCount, :start) + :inc",
          ExpressionAttributeValues: {
            ":websites": { SS: Array.from(updatedOriginWebsites) },
            ":start": { N: "0" },
            ":inc": { N: "1" },
          },
          ReturnValues: "ALL_NEW",
        })
      );

      const updatedItem = updateResult.Attributes;

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowOrigin,
        },
        body: JSON.stringify({
          message: "File already exists",
          imageHash: sha256Hash,
          pHash: pHash,
          s3ObjectUrl: updatedItem.s3ObjectUrl.S,
          originWebsites: updatedItem.originWebsites.SS,
          requestCount: parseInt(updatedItem.requestCount.N),
        }),
      };
    } else if (similarImages.Items && similarImages.Items.length > 0) {
      console.log("Similar image detected");

      const similarImage = similarImages.Items[0];
      const updatedOriginWebsites = new Set(
        similarImage.originWebsites ? similarImage.originWebsites.SS : []
      );
      updatedOriginWebsites.add(origin);

      // Update DynamoDB with the new origin website and increment requestCount
      const updateResult = await dynamoDBClient.send(
        new UpdateItemCommand({
          TableName: dynamoDBTableName,
          Key: {
            ImageHash: { S: similarImage.ImageHash.S },
          },
          UpdateExpression:
            "SET originWebsites = :websites, requestCount = if_not_exists(requestCount, :start) + :inc",
          ExpressionAttributeValues: {
            ":websites": { SS: Array.from(updatedOriginWebsites) },
            ":start": { N: "0" },
            ":inc": { N: "1" },
          },
          ReturnValues: "ALL_NEW",
        })
      );

      const updatedItem = updateResult.Attributes;

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowOrigin,
        },
        body: JSON.stringify({
          message: "Similar file exists",
          imageHash: sha256Hash,
          pHash: pHash,
          s3ObjectUrl: updatedItem.s3ObjectUrl.S,
          originWebsites: updatedItem.originWebsites.SS,
          requestCount: parseInt(updatedItem.requestCount.N),
        }),
      };
    } else {
      // Proceed with upload and saving to DynamoDB
      console.log("Uploading to S3...");
      console.log(`Original fileName: ${fileName}`);
      console.log(`Detected mimeType: ${mimeType}`);
      const { ext: fileExtension, extensionSource } = getFileExtensionFromData(
        fileName,
        url,
        mimeType,
        fileData
      );
      console.log(`Determined fileExtension: ${fileExtension}`);
      console.log(`Extension source: ${extensionSource}`);
      const s3Key = `${sha256Hash.slice(0, 16)}${fileExtension}`;
      console.log(`Generated S3 key: ${s3Key}`);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3BucketName,
          Key: s3Key,
          Body: fileData,
          ContentType:
            mimeType === "application/octet-stream"
              ? `image/${fileExtension.slice(1)}`
              : mimeType,
        })
      );
      console.log("S3 upload successful");

      // Retrieve and compare the object from S3
      console.log("Retrieving object from S3 for verification...");
      const getObjectResult = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3BucketName,
          Key: s3Key,
        })
      );

      const s3Data = await streamToBuffer(getObjectResult.Body);

      const isDataEqual = Buffer.compare(fileData, s3Data) === 0;
      console.log(`Data match between original and S3 object: ${isDataEqual}`);

      const s3DataHash = crypto
        .createHash("sha256")
        .update(s3Data)
        .digest("hex");
      console.log(`S3 object SHA-256 hash: ${s3DataHash}`);

      const s3ObjectUrl = `https://${s3BucketName}.s3.${awsRegion}.amazonaws.com/${s3Key}`;

      console.log("Saving to DynamoDB...");
      await dynamoDBClient.send(
        new PutItemCommand({
          TableName: dynamoDBTableName,
          Item: {
            ImageHash: { S: sha256Hash },
            PHash: { S: pHash },
            s3ObjectUrl: { S: s3ObjectUrl },
            uploadDate: { S: new Date().toISOString() },
            originalFileName: { S: fileName },
            originWebsites: { SS: [origin] },
            requestCount: { N: "1" },
            imageOriginUrl: { S: url }, // Add the image origin URL
            fileExtension: { S: fileExtension },
            extensionSource: { S: extensionSource },
          },
        })
      );

      // Modify the success response to include new information
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
          imageHash: sha256Hash,
          pHash: pHash,
          s3ObjectUrl: s3ObjectUrl,
          dataMatch: isDataEqual,
          originalFileName: fileName,
          originWebsites: [origin],
          requestCount: 1,
          imageOriginUrl: url,
          fileExtension: fileExtension,
          extensionSource: extensionSource,
        }),
      };
    }
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
