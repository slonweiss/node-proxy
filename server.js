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
import ExifReader from "exif-reader";
import * as c2pa from "c2pa";
import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from "@aws-sdk/client-sagemaker-runtime";

// Use environment variables
const s3BucketName = process.env.S3_BUCKET;
const dynamoDBTableName = process.env.DYNAMODB_TABLE;
const awsRegion = process.env.AWS_REGION || "us-east-2"; // Default to us-east-2 if not set

const s3Client = new S3Client({
  region: awsRegion,
  logger: console, // Enable AWS SDK logging
});

const dynamoDBClient = new DynamoDBClient({ region: awsRegion });

const sageMakerClient = new SageMakerRuntimeClient({ region: awsRegion });

const allowedOrigins = [
  "https://www.linkedin.com",
  "https://www.facebook.com",
  "https://www.twitter.com",
  "https://www.x.com",
  "https://www.instagram.com",
  "https://www.reddit.com",
  "https://realeyes.ai",
  "https://api.realeyes.ai",
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

// Add this function after the existing utility functions
const getValidOrigin = (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const referer = event.headers.referer || event.headers.Referrer || "";

  // Check if the origin is in the allowed list
  if (allowedOrigins.includes(origin)) {
    return origin;
  }

  // If origin is not in the allowed list, try to extract from referer
  for (const allowedOrigin of allowedOrigins) {
    if (referer.startsWith(allowedOrigin)) {
      return allowedOrigin;
    }
  }

  // If no valid origin is found, return null
  return null;
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

async function extractAllMetadata(buffer) {
  let metadata = {};

  try {
    // Extract metadata using sharp
    const sharpMetadata = await sharp(buffer).metadata();
    metadata.sharp = sharpMetadata;

    // Extract EXIF data
    try {
      const exif = ExifReader.load(buffer);
      metadata.exif = exif;
    } catch (exifError) {
      console.log(
        "No EXIF data found or error reading EXIF data:",
        exifError.message
      );
    }

    // Extract C2PA data
    try {
      const c2paData = await c2pa.read(buffer);
      if (c2paData) {
        metadata.c2pa = {
          activeManifest: c2paData.activeManifest,
          manifestStore: c2paData.manifestStore,
          ingredients: c2paData.ingredients,
          thumbnail: c2paData.thumbnail,
          // Add any other relevant C2PA data you want to store
        };
      }
    } catch (c2paError) {
      console.log(
        "No C2PA data found or error reading C2PA data:",
        c2paError.message
      );
    }
  } catch (error) {
    console.error("Error extracting metadata:", error);
  }

  return metadata;
}

const invokeSageMaker = async (imageBuffer) => {
  try {
    console.log(
      "SageMaker Endpoint Name:",
      process.env.SAGEMAKER_ENDPOINT_NAME
    );

    if (!process.env.SAGEMAKER_ENDPOINT_NAME) {
      throw new Error(
        "SAGEMAKER_ENDPOINT_NAME environment variable is not set"
      );
    }

    // Convert buffer to base64
    const base64Image = imageBuffer.toString("base64");

    const command = new InvokeEndpointCommand({
      EndpointName: process.env.SAGEMAKER_ENDPOINT_NAME,
      ContentType: "application/json",
      Body: JSON.stringify({ image: base64Image }),
    });

    const response = await sageMakerClient.send(command);
    const result = JSON.parse(Buffer.from(response.Body).toString("utf8"));

    return {
      logit: result.logit,
      probability: result.probability,
      isFake: result.is_fake,
    };
  } catch (error) {
    console.error("SageMaker Configuration:", {
      endpointName: process.env.SAGEMAKER_ENDPOINT_NAME,
      region: process.env.AWS_REGION,
    });
    console.error("Error invoking SageMaker endpoint:", error);
    throw error;
  }
};

export const handler = async (event) => {
  console.log(
    "Received event:",
    JSON.stringify(
      {
        ...event,
        body: event.isBase64Encoded
          ? "[Base64 body truncated]"
          : "[Body truncated]",
        // Include other relevant event properties you want to log
        httpMethod: event.httpMethod,
        headers: event.headers,
        queryStringParameters: event.queryStringParameters,
      },
      null,
      2
    )
  );

  const origin = event.headers["Origin"] || event.headers["origin"];
  const allowOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Access-Control-Max-Age": "86400",
      },
      body: "",
    };
  }

  let allMetadata = {};

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    console.log("Content-Type:", contentType);

    if (!contentType || !contentType.includes("multipart/form-data")) {
      console.error("Invalid or missing Content-Type header");
      return {
        statusCode: 400,
        headers: {
          ...corsHeaders,
        },
        body: JSON.stringify({ error: "Invalid Content-Type" }),
      };
    }

    // Decode the base64 body if necessary
    const decodedBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("binary")
      : event.body;

    console.log("Is base64 encoded:", event.isBase64Encoded);
    console.log("First 100 characters of body:", decodedBody.slice(0, 100));

    // Parse the multipart form data using the decoded body
    console.log("Parsing multipart form data...");
    const result = await parse({
      ...event,
      body: decodedBody,
      isBase64Encoded: false, // Since we've already decoded it
    });

    console.log(
      "Parse result:",
      JSON.stringify(
        {
          ...result,
          files: result.files?.map((file) => ({
            ...file,
            content: "[File content truncated]",
          })),
          fields: result.fields,
        },
        null,
        2
      )
    );

    const { files, fields } = result;

    // The URL is at the top level of the result, not in fields
    const url = result.url || "";

    console.log("URL from result:", result.url);
    console.log("Processed URL value:", url);

    if (!files || files.length === 0) {
      throw new Error("No files found in the request");
    }

    const file = files[0];
    let fileData = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, "binary");
    const fileName = file.filename;
    const mimeType = file.contentType;
    console.log("URL from fields:", fields?.url);
    console.log("Processed URL value:", url);

    console.log(`File received: ${fileName}`);
    console.log(`File size: ${fileData.length} bytes`);
    console.log(`Content-Type: ${mimeType}`);
    console.log(`First 16 bytes: ${fileData.slice(0, 16).toString("hex")}`);
    console.log(`URL: ${url}`);

    // Calculate both hashes
    const sha256Hash = crypto
      .createHash("sha256")
      .update(fileData)
      .digest("hex");
    const pHash = await calculatePHash(fileData);

    console.log(`Received image SHA-256 hash: ${sha256Hash}`);
    console.log(`Calculated pHash: ${pHash}`);

    // Extract metadata
    allMetadata = await extractAllMetadata(fileData);

    // Add SageMaker analysis
    const sageMakerResult = await invokeSageMaker(fileData);
    console.log("SageMaker analysis result:", sageMakerResult);

    // Check for exact duplicate only
    const exactDuplicate = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: dynamoDBTableName,
        Key: {
          ImageHash: { S: sha256Hash },
        },
      })
    );

    if (exactDuplicate.Item) {
      console.log("Duplicate file detected");

      const updatedOriginWebsites = new Set(
        exactDuplicate.Item.originWebsites
          ? exactDuplicate.Item.originWebsites.SS
          : []
      );
      if (origin) {
        updatedOriginWebsites.add(origin);
      }

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
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "File already exists",
          imageHash: sha256Hash,
          pHash: updatedItem.PHash.S,
          s3ObjectUrl: updatedItem.s3ObjectUrl.S,
          originalFileName: updatedItem.originalFileName.S,
          originWebsites: updatedItem.originWebsites.SS,
          requestCount: parseInt(updatedItem.requestCount.N),
          imageOriginUrl: updatedItem.originalUrl.S,
          fileExtension: updatedItem.fileExtension.S,
          extensionSource: updatedItem.extensionSource.S,
          uploadDate: updatedItem.uploadDate.S,
          fileSize: parseInt(updatedItem.fileSize.N),
          allMetadata: JSON.parse(updatedItem.allMetadata.S),
          sageMakerAnalysis: {
            logit: parseFloat(updatedItem.sageMakerAnalysisCorvi23.M.logit.N),
            probability: parseFloat(
              updatedItem.sageMakerAnalysisCorvi23.M.probability.N
            ),
            isFake: updatedItem.sageMakerAnalysisCorvi23.M.isFake.BOOL,
          },
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
      console.log("Received values:");
      console.log("fileName:", fileName);
      console.log("url:", url);
      console.log("mimeType:", mimeType);
      console.log("origin:", origin);
      console.log("sha256Hash:", sha256Hash);
      console.log("pHash:", pHash);
      console.log("originalUrl:", url);
      const dynamoDBItem = {
        ImageHash: { S: sha256Hash },
        PHash: { S: pHash },
        s3ObjectUrl: { S: s3ObjectUrl },
        originalUrl: { S: url || "" },
        uploadDate: { S: new Date().toISOString() },
        originalFileName: { S: fileName },
        requestCount: { N: "1" },
        fileExtension: { S: fileExtension },
        extensionSource: { S: extensionSource },
        fileSize: { N: fileData.length.toString() },
        allMetadata: { S: JSON.stringify(allMetadata) },
        sageMakerAnalysisCorvi23: {
          M: {
            logit: { N: sageMakerResult.logit.toString() },
            probability: { N: sageMakerResult.probability.toString() },
            isFake: { BOOL: sageMakerResult.isFake },
          },
        },
      };

      // Only add originWebsites if it's not empty
      if (origin && origin.length > 0) {
        dynamoDBItem.originWebsites = { SS: [origin] };
      }

      console.log("DynamoDB Item:", JSON.stringify(dynamoDBItem, null, 2));

      // Add this before saving to DynamoDB
      console.log("Full metadata being saved:");
      console.log(JSON.stringify(dynamoDBItem, null, 2));

      try {
        await dynamoDBClient.send(
          new PutItemCommand({
            TableName: dynamoDBTableName,
            Item: dynamoDBItem,
          })
        );
        console.log("Successfully saved to DynamoDB");
      } catch (error) {
        console.error("Error saving to DynamoDB:", error);
        console.error(
          "DynamoDB Item that caused the error:",
          JSON.stringify(dynamoDBItem, null, 2)
        );
        throw error; // Re-throw the error to be caught by the main try-catch block
      }

      // Modify the success response to include new information
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "Image uploaded successfully",
          imageHash: sha256Hash,
          pHash: pHash,
          s3ObjectUrl: s3ObjectUrl,
          dataMatch: isDataEqual,
          originalFileName: fileName,
          originWebsites: origin ? [origin] : [],
          requestCount: 1,
          imageOriginUrl: url,
          fileExtension: fileExtension,
          extensionSource: extensionSource,
          sageMakerAnalysis: sageMakerResult,
        }),
      };
    }
  } catch (error) {
    console.error("Error processing image:", error);
    console.error("Error stack:", error.stack);
    console.error("Metadata object:", allMetadata || "No metadata available");
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
    };
  }
};
