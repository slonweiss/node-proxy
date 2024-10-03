import Busboy from "busboy";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

const s3Client = new S3Client({ region: "us-west-2" });
const dynamoDBClient = new DynamoDBClient({ region: "us-west-2" });

const allowedOrigins = [
  "https://www.linkedin.com",
  "https://www.facebook.com",
  "https://www.twitter.com",
  "https://www.x.com",
  "https://www.instagram.com",
  "https://www.reddit.com",
];

export const handler = async (event, context) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  console.log("Headers:", JSON.stringify(event.headers, null, 2));
  console.log("Body length:", event.body ? event.body.length : 0);

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

  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    console.log("Content-Type:", contentType);

    if (!contentType || !contentType.includes("multipart/form-data")) {
      console.error("Invalid or missing Content-Type header");
      return resolve({
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": allowOrigin,
        },
        body: JSON.stringify({ error: "Invalid Content-Type" }),
      });
    }

    const busboy = Busboy({ headers: event.headers });
    let fileData = null;
    let fileName = null;
    let mimeType = null;

    busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
      console.log("File event triggered");
      fileName = filename;
      mimeType = mimetype;
      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        fileData = Buffer.concat(chunks);
        console.log("File received, size:", fileData.length);
        console.log("First 16 bytes:", fileData.slice(0, 16).toString("hex"));
      });
    });

    busboy.on("finish", async () => {
      console.log("Busboy finished");
      try {
        if (!fileData) {
          throw new Error("No file data received");
        }

        console.log("File size:", fileData.length);
        console.log("Content-Type:", mimeType);
        console.log("First 16 bytes:", fileData.slice(0, 16).toString("hex"));

        const hash = crypto
          .createHash("md5")
          .update(fileData)
          .digest("hex")
          .slice(0, 10);

        const fileExtension = path.extname(fileName).slice(1).toLowerCase();

        const s3Key = `${path.parse(fileName).name}_${hash}.${fileExtension}`;
        console.log("S3 Key:", s3Key);

        const s3Client = new S3Client();
        const putObjectCommand = new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
          Body: fileData,
          ContentType: mimeType,
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
            OriginalFileName: { S: fileName },
            MimeType: { S: mimeType },
          },
        });

        console.log("Saving to DynamoDB...");
        await dynamoClient.send(putItemCommand);
        console.log("DynamoDB save successful");

        const response = {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": allowOrigin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
          body: JSON.stringify({
            message: "Image uploaded successfully",
            imageHash: hash,
            s3ObjectUrl: s3ObjectUrl,
          }),
        };

        resolve(response);
      } catch (error) {
        console.error("Error processing image:", error);
        resolve({
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
        });
      }
    });

    // Parse the event body
    const buffer = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "binary");

    busboy.write(buffer);
    busboy.end();
  });
};
