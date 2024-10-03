import Busboy from "busboy";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import path from "path";

export const handler = async (event, context) => {
  console.log("Received event");

  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];

    const busboy = Busboy({
      headers: {
        "content-type": contentType,
      },
    });

    let fileData = null;
    let filename = null;
    let mimeType = null;

    busboy.on("file", (fieldname, file, info) => {
      filename = info.filename;
      mimeType = info.mimeType;
      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        fileData = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", async () => {
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

        resolve({
          statusCode: 200,
          body: JSON.stringify({
            result: "Image processed and saved successfully",
            fileType: mimeType,
            fileSize: fileData.length,
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

    busboy.write(Buffer.from(event.body, "base64"));
    busboy.end();
  });
};
