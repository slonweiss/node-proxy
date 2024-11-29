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
import * as ExifReader from "exif-reader";
import { createC2pa } from "c2pa-node";
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
  const xOrigin = event.headers["x-origin"] || event.headers["X-Origin"];
  const origin = event.headers.origin || event.headers.Origin;
  const referer = event.headers.referer || event.headers.Referrer;

  // First check x-origin header
  if (xOrigin) {
    const xOriginDomain = new URL(xOrigin).origin;
    if (allowedOrigins.includes(xOriginDomain)) {
      return xOriginDomain;
    }
  }

  // Then check regular origin
  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }

  // Finally check referer
  if (referer) {
    for (const allowedOrigin of allowedOrigins) {
      if (referer.startsWith(allowedOrigin)) {
        return allowedOrigin;
      }
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
    console.log("Starting metadata extraction...");
    const sharpMetadata = await sharp(buffer).metadata();
    console.log("Sharp metadata:", sharpMetadata);
    metadata.sharp = sharpMetadata;

    // EXIF logging
    try {
      console.log("Attempting to extract EXIF data...");
      console.log("EXIF buffer exists:", !!sharpMetadata.exif);
      if (sharpMetadata.exif) {
        const exif = ExifReader.default(sharpMetadata.exif);
        console.log("EXIF data extracted:", exif);
        metadata.exif = exif;
      }
    } catch (exifError) {
      console.error("EXIF extraction failed:", {
        error: exifError,
        message: exifError.message,
        stack: exifError.stack,
      });
      metadata.exif = null;
    }

    // C2PA logging with Node.js library
    try {
      console.log("Attempting to extract C2PA data...");
      const c2pa = createC2pa();
      console.log("C2PA instance created");

      const c2paResult = await c2pa.read({
        buffer,
        mimeType: metadata.sharp.format
          ? `image/${metadata.sharp.format}`
          : "image/jpeg",
      });

      console.log("C2PA data extracted:", c2paResult);

      if (c2paResult) {
        metadata.c2pa = {
          activeManifest: c2paResult.active_manifest,
          manifestStore: c2paResult.manifests,
          validationStatus: c2paResult.validation_status,
        };
      } else {
        console.log("No C2PA data found in image");
        metadata.c2pa = null;
      }
    } catch (c2paError) {
      console.error("C2PA extraction failed:", {
        error: c2paError,
        message: c2paError.message,
        stack: c2paError.stack,
      });
      metadata.c2pa = null;
    }
  } catch (error) {
    console.error("General metadata extraction error:", {
      error,
      message: error.message,
      stack: error.stack,
    });
  }

  // Ensure we always return an object with all expected fields
  return {
    sharp: metadata.sharp || null,
    exif: metadata.exif || null,
    c2pa: metadata.c2pa || null,
  };
}

const invokeSageMaker = async (imageBuffer) => {
  try {
    console.log(
      "SageMaker Endpoint Names:",
      process.env.SAGEMAKER_ENDPOINT_NAME,
      process.env.UNIVERSAL_FAKE_DETECT_ENDPOINT
    );

    if (
      !process.env.SAGEMAKER_ENDPOINT_NAME ||
      !process.env.UNIVERSAL_FAKE_DETECT_ENDPOINT
    ) {
      console.warn("SageMaker endpoint environment variables are not set");
      return null;
    }

    // Convert buffer to base64
    const base64Image = imageBuffer.toString("base64");
    const payload = JSON.stringify({ image: base64Image });

    // Invoke both endpoints in parallel with error handling for each
    const [corviResponse, ufdResponse] = await Promise.allSettled([
      sageMakerClient.send(
        new InvokeEndpointCommand({
          EndpointName: process.env.SAGEMAKER_ENDPOINT_NAME,
          ContentType: "application/json",
          Body: payload,
        })
      ),
      sageMakerClient.send(
        new InvokeEndpointCommand({
          EndpointName: process.env.UNIVERSAL_FAKE_DETECT_ENDPOINT,
          ContentType: "application/json",
          Body: payload,
        })
      ),
    ]);

    // Initialize results
    let corviResult = null;
    let ufdResult = null;

    // Process Corvi response if successful
    if (corviResponse.status === "fulfilled") {
      try {
        corviResult = JSON.parse(
          Buffer.from(corviResponse.value.Body).toString("utf8")
        );
      } catch (error) {
        console.error("Error parsing Corvi response:", error);
      }
    } else {
      console.error("Corvi endpoint error:", corviResponse.reason);
    }

    // Process UFD response if successful
    if (ufdResponse.status === "fulfilled") {
      try {
        ufdResult = JSON.parse(
          Buffer.from(ufdResponse.value.Body).toString("utf8")
        );
      } catch (error) {
        console.error("Error parsing UFD response:", error);
      }
    } else {
      console.error("UFD endpoint error:", ufdResponse.reason);
    }

    // Return results, with null values for failed endpoints
    return {
      corvi: corviResult
        ? {
            logit: corviResult.logit,
            probability: corviResult.probability,
            isFake: corviResult.is_fake,
          }
        : null,
      ufd: ufdResult
        ? {
            logit: ufdResult.logit,
            probability: ufdResult.probability,
            isFake: ufdResult.is_fake,
          }
        : null,
    };
  } catch (error) {
    console.error("SageMaker Configuration:", {
      corviEndpoint: process.env.SAGEMAKER_ENDPOINT_NAME,
      ufdEndpoint: process.env.UNIVERSAL_FAKE_DETECT_ENDPOINT,
      region: process.env.AWS_REGION,
    });
    console.error("Error invoking SageMaker endpoints:", error);
    return null;
  }
};

function processImageUrl(url) {
  if (!url) return "";

  // Check if it's a data URL
  if (url.startsWith("data:")) {
    // Return a flag instead of the full data URL
    return "[data-url]";
  }

  // Return the regular URL as is
  return url;
}

// Add JWT verification function
const verifyToken = (authHeader) => {
  console.log(
    "Verifying JWT token from auth header:",
    authHeader?.substring(0, 20) + "..."
  );
  try {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("No valid Bearer token found in auth header");
      return null;
    }
    const token = authHeader.split(" ")[1];
    const decoded = Buffer.from(token.split(".")[1], "base64").toString();
    const payload = JSON.parse(decoded);
    console.log("Successfully decoded JWT payload:", payload);
    return payload;
  } catch (error) {
    console.error("Error decoding JWT:", error);
    return null;
  }
};

// Add after other utility functions
const logImageRequest = async (imageHash, userId, origin) => {
  console.log("Attempting to log image request:", {
    imageHash,
    userId,
    origin,
  });

  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID();

  const logItem = {
    requestId: { S: requestId },
    userId: { S: userId || "anonymous" },
    imageHash: { S: imageHash },
    timestamp: { S: timestamp },
    origin: { S: origin || "unknown" },
  };

  console.log("Constructed DynamoDB item:", JSON.stringify(logItem, null, 2));
  console.log("Using table name:", process.env.REQUEST_LOG_TABLE);

  try {
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: process.env.REQUEST_LOG_TABLE,
        Item: logItem,
      })
    );
    console.log("Successfully logged request to DynamoDB");
  } catch (error) {
    console.error("Error logging request to DynamoDB:", error);
    console.error("Error details:", {
      errorName: error.name,
      errorMessage: error.message,
      stackTrace: error.stack,
    });
    throw error;
  }
};

// Modify the metadata preparation for DynamoDB
const prepareDynamoDBItem = (metadata) => {
  try {
    // Helper function to safely convert values to DynamoDB format
    const toDynamoDBValue = (value) => {
      if (value === null || value === undefined) {
        return { NULL: true };
      }
      if (typeof value === "string") {
        return { S: value };
      }
      if (typeof value === "number") {
        return { N: value.toString() };
      }
      if (typeof value === "boolean") {
        return { BOOL: value };
      }
      if (Array.isArray(value)) {
        // Only process non-empty arrays of simple values
        if (value.length === 0) {
          return { L: [] };
        }
        return { L: value.map((item) => toDynamoDBValue(item.toString())) };
      }
      // For objects, convert to string to avoid nested structure issues
      return { S: JSON.stringify(value) };
    };

    // Process Sharp metadata (only simple values)
    const sharpAttributes = {
      format: metadata.sharp?.format,
      size: metadata.sharp?.size,
      width: metadata.sharp?.width,
      height: metadata.sharp?.height,
      space: metadata.sharp?.space,
      channels: metadata.sharp?.channels,
      depth: metadata.sharp?.depth,
      density: metadata.sharp?.density,
      chromaSubsampling: metadata.sharp?.chromaSubsampling,
      isProgressive: metadata.sharp?.isProgressive,
      hasProfile: metadata.sharp?.hasProfile,
      hasAlpha: metadata.sharp?.hasAlpha,
    };

    // Process C2PA metadata (simplified)
    const c2paAttributes = metadata.c2pa
      ? {
          generator: metadata.c2pa.activeManifest?.claim_generator,
          title: metadata.c2pa.activeManifest?.title,
          format: metadata.c2pa.activeManifest?.format,
          instanceId: metadata.c2pa.activeManifest?.instance_id,
          label: metadata.c2pa.activeManifest?.label,
          manifestCount: Object.keys(metadata.c2pa.manifestStore || {}).length,
          signatureInfo: JSON.stringify({
            alg: metadata.c2pa.activeManifest?.signature_info?.alg,
            issuer: metadata.c2pa.activeManifest?.signature_info?.issuer,
            time: metadata.c2pa.activeManifest?.signature_info?.time,
          }),
        }
      : null;

    // Convert to DynamoDB format
    return {
      metadata: {
        M: {
          sharp: {
            M: Object.entries(sharpAttributes)
              .filter(([_, value]) => value !== undefined)
              .reduce(
                (acc, [key, value]) => ({
                  ...acc,
                  [key]: toDynamoDBValue(value),
                }),
                {}
              ),
          },
          c2pa: c2paAttributes
            ? {
                M: Object.entries(c2paAttributes)
                  .filter(([_, value]) => value !== undefined)
                  .reduce(
                    (acc, [key, value]) => ({
                      ...acc,
                      [key]: toDynamoDBValue(value),
                    }),
                    {}
                  ),
              }
            : { NULL: true },
        },
      },
    };
  } catch (error) {
    console.error("Error preparing DynamoDB item:", error);
    return {
      metadata: {
        M: {
          sharp: { NULL: true },
          c2pa: { NULL: true },
        },
      },
    };
  }
};

// Add this utility function after other utility functions
const getAttributeSize = (attribute) => {
  if (!attribute) return 0;
  return Buffer.from(JSON.stringify(attribute)).length;
};

const logAttributeSizes = (item) => {
  console.log("DynamoDB Item Size Analysis:");
  Object.entries(item).forEach(([key, value]) => {
    const size = getAttributeSize(value);
    console.log(`- ${key}: ${size} bytes`);

    // If it's metadata, drill down further
    if (key === "metadata" && value.M) {
      console.log("  Metadata breakdown:");
      Object.entries(value.M).forEach(([metaKey, metaValue]) => {
        console.log(`  - ${metaKey}: ${getAttributeSize(metaValue)} bytes`);
      });
    }
  });
};

// Add this function to simplify C2PA data
const simplifyC2paData = (c2paData) => {
  if (!c2paData) return null;

  // Simplify active manifest
  const simplifiedActiveManifest = c2paData.active_manifest
    ? {
        claim_generator: c2paData.active_manifest.claim_generator,
        title: c2paData.active_manifest.title,
        format: c2paData.active_manifest.format,
        instance_id: c2paData.active_manifest.instance_id,
        signature_info: {
          alg: c2paData.active_manifest.signature_info?.alg,
          issuer: c2paData.active_manifest.signature_info?.issuer,
          time: c2paData.active_manifest.signature_info?.time,
        },
        label: c2paData.active_manifest.label,
        // Include count of ingredients and assertions instead of full arrays
        ingredientsCount: c2paData.active_manifest.ingredients?.length || 0,
        assertionsCount: c2paData.active_manifest.assertions?.length || 0,
      }
    : null;

  // Simplify manifests - just include basic info and counts
  const simplifiedManifests = {};
  if (c2paData.manifests) {
    Object.entries(c2paData.manifests).forEach(([key, manifest]) => {
      simplifiedManifests[key] = {
        claim_generator: manifest.claim_generator,
        title: manifest.title,
        format: manifest.format,
        instance_id: manifest.instance_id,
        ingredientsCount: manifest.ingredients?.length || 0,
        assertionsCount: manifest.assertions?.length || 0,
        signature_info: {
          alg: manifest.signature_info?.alg,
          issuer: manifest.signature_info?.issuer,
          time: manifest.signature_info?.time,
        },
      };
    });
  }

  return {
    active_manifest: simplifiedActiveManifest,
    manifests: simplifiedManifests,
    validation_status: c2paData.validation_status || [],
    manifestCount: Object.keys(c2paData.manifests || {}).length,
  };
};

const createErrorResponse = (statusCode, message, details = null) => {
  const response = {
    error: {
      message,
      timestamp: new Date().toISOString(),
      requestId: crypto.randomUUID(),
    },
  };

  if (details) {
    response.error.details = details;
  }

  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(response),
  };
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

  const origin = getValidOrigin(event);
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
    // Get userId from the parsed result directly
    const userId = result.userId || "anonymous";
    console.log("User ID from request:", userId);

    // Get storeData from the parsed result directly
    const storeData =
      result.storeData?.toLowerCase?.() === "true" || result.storeData === "1";
    console.log("Parsed form data:", {
      storeData,
      resultValue: result.storeData,
      resultValueType: typeof result.storeData,
      parsedBoolean: storeData,
    });

    // The URL is at the top level of the result, not in fields
    const url = result.url || "";
    const processedUrl = processImageUrl(url);

    console.log("URL from result:", result.url);
    console.log("Processed URL value:", processedUrl);

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
    console.log("Processed URL value:", processedUrl);

    console.log(`File received: ${fileName}`);
    console.log(`File size: ${fileData.length} bytes`);
    console.log(`Content-Type: ${mimeType}`);
    console.log(`First 16 bytes: ${fileData.slice(0, 16).toString("hex")}`);
    console.log(`URL: ${processedUrl}`);

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

      // Format metadata similar to new images
      const formattedMetadata = {
        sharp: {
          format: updatedItem?.metadata?.M?.sharp?.M?.format?.S,
          size: parseInt(updatedItem?.metadata?.M?.sharp?.M?.size?.N),
          width: parseInt(updatedItem?.metadata?.M?.sharp?.M?.width?.N),
          height: parseInt(updatedItem?.metadata?.M?.sharp?.M?.height?.N),
          space: updatedItem?.metadata?.M?.sharp?.M?.space?.S,
          channels: parseInt(updatedItem?.metadata?.M?.sharp?.M?.channels?.N),
          depth: updatedItem?.metadata?.M?.sharp?.M?.depth?.S,
          density: parseInt(updatedItem?.metadata?.M?.sharp?.M?.density?.N),
          chromaSubsampling:
            updatedItem?.metadata?.M?.sharp?.M?.chromaSubsampling?.S,
          isProgressive:
            updatedItem?.metadata?.M?.sharp?.M?.isProgressive?.BOOL,
          hasProfile: updatedItem?.metadata?.M?.sharp?.M?.hasProfile?.BOOL,
          hasAlpha: updatedItem?.metadata?.M?.sharp?.M?.hasAlpha?.BOOL,
        },
        exif: updatedItem?.metadata?.M?.exif?.M || {},
        c2pa: updatedItem?.metadata?.M?.c2pa?.M || {},
      };

      // Format SageMaker analysis results
      const formattedSageMakerAnalysis = {
        corvi: {
          logit: parseFloat(updatedItem?.sageMakerAnalysisCorvi23?.M?.logit?.N),
          probability: parseFloat(
            updatedItem?.sageMakerAnalysisCorvi23?.M?.probability?.N
          ),
          isFake: updatedItem?.sageMakerAnalysisCorvi23?.M?.isFake?.BOOL,
        },
        ufd: {
          logit: parseFloat(updatedItem?.sageMakerAnalysisUFD?.M?.logit?.N),
          probability: parseFloat(
            updatedItem?.sageMakerAnalysisUFD?.M?.probability?.N
          ),
          isFake: updatedItem?.sageMakerAnalysisUFD?.M?.isFake?.BOOL,
        },
      };

      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "File already exists",
          imageHash: sha256Hash,
          pHash: updatedItem?.PHash?.S,
          s3ObjectUrl: updatedItem?.s3ObjectUrl?.S,
          originalFileName: updatedItem?.originalFileName?.S,
          originWebsites: updatedItem?.originWebsites?.SS || [],
          requestCount: updatedItem?.requestCount?.N
            ? parseInt(updatedItem.requestCount.N)
            : 1,
          imageOriginUrl: updatedItem?.originalUrl?.S || "",
          fileExtension: updatedItem?.fileExtension?.S,
          extensionSource: updatedItem?.extensionSource?.S,
          uploadDate: updatedItem?.uploadDate?.S,
          fileSize: updatedItem?.fileSize?.N
            ? parseInt(updatedItem.fileSize.N)
            : 0,
          metadata: formattedMetadata,
          sageMakerAnalysis: formattedSageMakerAnalysis.corvi,
          sageMakerAnalysisUFD: formattedSageMakerAnalysis.ufd,
        }),
      };
    } else {
      // Proceed with analysis and conditional storage
      console.log("Processing new image...");
      console.log(`Original fileName: ${fileName}`);
      console.log(`Detected mimeType: ${mimeType}`);
      const { ext: fileExtension, extensionSource } = getFileExtensionFromData(
        fileName,
        processedUrl,
        mimeType,
        fileData
      );
      console.log(`Determined fileExtension: ${fileExtension}`);
      console.log(`Extension source: ${extensionSource}`);

      let s3ObjectUrl = "";
      let isDataEqual = false;
      let s3DataHash = "";

      if (storeData) {
        console.log("Starting S3 upload process - storeData is true");
        // Only store in S3 if storeData is true
        console.log("Uploading to S3...");
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

        // Verify S3 upload
        const getObjectResult = await s3Client.send(
          new GetObjectCommand({
            Bucket: s3BucketName,
            Key: s3Key,
          })
        );

        const s3Data = await streamToBuffer(getObjectResult.Body);
        isDataEqual = Buffer.compare(fileData, s3Data) === 0;
        s3DataHash = crypto.createHash("sha256").update(s3Data).digest("hex");
        s3ObjectUrl = `https://${s3BucketName}.s3.${awsRegion}.amazonaws.com/${s3Key}`;
        console.log(
          `Data match between original and S3 object: ${isDataEqual}`
        );
        console.log(`S3 object SHA-256 hash: ${s3DataHash}`);
      } else {
        console.log("Skipping S3 upload - storeData is false");
      }

      // Save to DynamoDB with conditional S3 information
      const dynamoDBItem = {
        ImageHash: { S: sha256Hash },
        PHash: { S: pHash },
        uploadDate: { S: new Date().toISOString() },
        originalFileName: { S: fileName },
        originalUrl: processedUrl ? { S: processedUrl } : { NULL: true },
        requestCount: { N: "1" },
        fileExtension: { S: fileExtension },
        extensionSource: { S: extensionSource },
        fileSize: { N: fileData.length.toString() },
      };

      // Only add SageMaker results if they exist
      if (sageMakerResult?.corvi) {
        dynamoDBItem.sageMakerAnalysisCorvi23 = {
          M: {
            logit: { N: sageMakerResult.corvi.logit.toString() },
            probability: { N: sageMakerResult.corvi.probability.toString() },
            isFake: { BOOL: sageMakerResult.corvi.isFake },
          },
        };
      }

      if (sageMakerResult?.ufd) {
        dynamoDBItem.sageMakerAnalysisUFD = {
          M: {
            logit: { N: sageMakerResult.ufd.logit.toString() },
            probability: { N: sageMakerResult.ufd.probability.toString() },
            isFake: { BOOL: sageMakerResult.ufd.isFake },
          },
        };
      }

      // Add metadata if available
      const preparedMetadata = prepareDynamoDBItem(allMetadata);
      if (preparedMetadata.metadata) {
        dynamoDBItem.metadata = preparedMetadata.metadata;
      }

      // Only add S3-related fields if storeData is true
      if (storeData) {
        console.log("Adding S3 URL to DynamoDB item");
        dynamoDBItem.s3ObjectUrl = { S: s3ObjectUrl };
      } else {
        console.log("Skipping S3 URL in DynamoDB item - storeData is false");
      }

      // Only add originWebsites if it's not empty
      if (origin && origin.length > 0) {
        dynamoDBItem.originWebsites = { SS: [origin] };
      }

      console.log("Final DynamoDB item structure:", {
        hasS3Url: !!dynamoDBItem.s3ObjectUrl,
        storeData,
        imageHash: dynamoDBItem.ImageHash.S,
        metadataFields: Object.keys(dynamoDBItem),
      });

      try {
        // Log sizes before attempting to save
        logAttributeSizes(dynamoDBItem);

        // DynamoDB has a 400KB item size limit
        const totalSize = getAttributeSize(dynamoDBItem);
        console.log(`Total DynamoDB item size: ${totalSize} bytes`);
        if (totalSize > 400000) {
          console.warn("WARNING: Item size exceeds DynamoDB's 400KB limit");
        }

        await dynamoDBClient.send(
          new PutItemCommand({
            TableName: dynamoDBTableName,
            Item: dynamoDBItem,
          })
        );
        console.log("Successfully saved to DynamoDB");
      } catch (error) {
        console.error("Error saving to DynamoDB:", error);
        console.error("Error details:", {
          name: error.name,
          message: error.message,
          code: error.$metadata?.httpStatusCode,
        });
        throw error;
      }

      // Add after SageMaker analysis
      try {
        await logImageRequest(sha256Hash, userId, origin);
        console.log("Request logging completed successfully");
      } catch (loggingError) {
        console.error(
          "Failed to log request, but continuing with response:",
          loggingError
        );
      }

      // In the response, filter out binary data
      const sanitizedMetadata = {
        sharp: {
          format: allMetadata.sharp?.format,
          size: allMetadata.sharp?.size,
          width: allMetadata.sharp?.width,
          height: allMetadata.sharp?.height,
          space: allMetadata.sharp?.space,
          channels: allMetadata.sharp?.channels,
          depth: allMetadata.sharp?.depth,
          density: allMetadata.sharp?.density,
          chromaSubsampling: allMetadata.sharp?.chromaSubsampling,
          isProgressive: allMetadata.sharp?.isProgressive,
          hasProfile: allMetadata.sharp?.hasProfile,
          hasAlpha: allMetadata.sharp?.hasAlpha,
        },
        exif: allMetadata.exif || {},
        c2pa: simplifyC2paData(allMetadata.c2pa),
      };

      // Update the response body to use sanitizedMetadata
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "Image processed successfully",
          imageHash: sha256Hash,
          pHash: pHash,
          s3ObjectUrl: storeData ? s3ObjectUrl : null,
          originalFileName: fileName,
          originWebsites: origin ? [origin] : [],
          requestCount: 1,
          imageOriginUrl: processedUrl,
          fileExtension: fileExtension,
          extensionSource: extensionSource,
          uploadDate: new Date().toISOString(),
          fileSize: fileData.length,
          metadata: sanitizedMetadata,
          ...(sageMakerResult?.corvi && {
            sageMakerAnalysis: sageMakerResult.corvi,
          }),
          ...(sageMakerResult?.ufd && {
            sageMakerAnalysisUFD: sageMakerResult.ufd,
          }),
        }),
      };
    }
  } catch (error) {
    console.error("Error processing image:", error);
    console.error("Error stack:", error.stack);
    console.error("Metadata object:", allMetadata || "No metadata available");

    let statusCode = 500;
    let errorMessage = "Internal server error";
    let errorDetails = null;

    // Categorize different types of errors
    if (error.name === "ValidationError") {
      statusCode = 400;
      errorMessage = "Invalid request data";
      errorDetails = error.message;
    } else if (error.name === "AuthorizationError") {
      statusCode = 401;
      errorMessage = "Authentication required";
    } else if (error.code === "EntityTooLarge") {
      statusCode = 413;
      errorMessage = "Image file too large";
    } else if (error.$metadata?.httpStatusCode) {
      // AWS service errors
      statusCode = error.$metadata.httpStatusCode;
      errorMessage = "Service temporarily unavailable";
      errorDetails = error.message;
    }

    return createErrorResponse(statusCode, errorMessage, errorDetails);
  }
};
