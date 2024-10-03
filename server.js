import { parse } from "lambda-multipart-parser";
import { fileTypeFromBuffer } from "file-type";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "..." : str;
}

export const handler = async (event, context) => {
  console.log("Received event:", truncate(JSON.stringify(event), 200));

  try {
    // Parse the multipart form data
    const result = await parse(event);

    const file = result.files[0];

    if (!file) {
      throw new Error("No file data received");
    }

    const { filename, content, contentType } = file;
    const buffer = content;

    console.log("File size:", buffer.length);
    console.log("Content-Type:", contentType);
    console.log("First 16 bytes:", buffer.slice(0, 16).toString("hex"));

    const fileTypeResult = await fileTypeFromBuffer(buffer);
    console.log(
      "Detected file type:",
      fileTypeResult ? fileTypeResult.mime : "unknown"
    );

    let finalContentType = contentType;
    let fileExtension = path.extname(filename).slice(1).toLowerCase();

    if (fileTypeResult) {
      finalContentType = fileTypeResult.mime;
      fileExtension = fileTypeResult.ext;
    } else {
      switch (fileExtension) {
        case "jpg":
        case "jpeg":
          finalContentType = "image/jpeg";
          break;
        case "png":
          finalContentType = "image/png";
          break;
        case "webp":
          finalContentType = "image/webp";
          break;
        default:
          throw new Error(`Unsupported file type: ${fileExtension}`);
      }
    }

    console.log("Final Content-Type:", finalContentType);

    const hash = crypto
      .createHash("md5")
      .update(buffer)
      .digest("hex")
      .slice(0, 10);

    const originalName = path.parse(filename).name;
    const s3Key = `${originalName}_${hash}.${fileExtension}`;
    console.log("S3 Key:", s3Key);

    const s3Client = new S3Client();
    const putObjectCommand = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: finalContentType,
    });

    console.log("Uploading to S3...");
    await s3Client.send(putObjectCommand);
    console.log("S3 upload successful");

    const s3ObjectUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${s3Key}`;

    const dynamoClient = new DynamoDBClient();
    const putItemCommand = new PutItemCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        ImageHash: { S: hash },
        S3ObjectUrl: { S: s3ObjectUrl },
        OriginalFileName: { S: filename },
        MimeType: { S: finalContentType },
      },
    });

    console.log("Saving to DynamoDB...");
    await dynamoClient.send(putItemCommand);
    console.log("DynamoDB save successful");

    return {
      statusCode: 200,
      body: JSON.stringify({
        result: "Image processed and saved successfully",
        fileType: finalContentType,
        fileSize: buffer.length,
        s3ObjectUrl: s3ObjectUrl,
        originalFileName: filename,
      }),
    };
  } catch (error) {
    console.error("Error processing image:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
    };
  }
};
