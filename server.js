import Busboy from "busboy";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

export const handler = async (event, context) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  console.log("Headers:", JSON.stringify(event.headers, null, 2));
  console.log("Body length:", event.body ? event.body.length : 0);

  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    console.log("Content-Type:", contentType);

    if (!contentType || !contentType.includes("multipart/form-data")) {
      console.error("Invalid or missing Content-Type header");
      return resolve({
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid Content-Type" }),
      });
    }

    const busboy = Busboy({
      headers: {
        "content-type": contentType,
      },
    });

    let fileData = null;
    let filename = null;
    let mimeType = null;

    busboy.on("file", (fieldname, file, info) => {
      console.log("File event triggered");
      filename = info.filename;
      mimeType = info.mimeType;
      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        fileData = Buffer.concat(chunks);
        console.log("File received, size:", fileData.length);
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

        // Decode base64 if the image is base64 encoded
        if (fileData.toString("ascii").startsWith("data:image")) {
          const base64Data = fileData.toString("ascii").split(",")[1];
          fileData = Buffer.from(base64Data, "base64");
          console.log("Decoded base64 image, new size:", fileData.length);
          console.log(
            "First 16 bytes after decoding:",
            fileData.slice(0, 16).toString("hex")
          );
        }

        const hash = crypto
          .createHash("md5")
          .update(fileData)
          .digest("hex")
          .slice(0, 10);

        const fileExtension = path.extname(filename).slice(1).toLowerCase();

        const s3Key = `${path.parse(filename).name}_${hash}.${fileExtension}`;
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
            OriginalFileName: { S: filename },
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
            "Access-Control-Allow-Origin": "*",
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
            "Access-Control-Allow-Origin": "*",
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
      : Buffer.from(event.body);

    busboy.end(buffer);
  });
};
