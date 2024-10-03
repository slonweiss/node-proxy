import Busboy from "busboy";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

const s3Client = new S3Client({ region: "us-west-2" });
const dynamoDBClient = new DynamoDBClient({ region: "us-west-2" });

export const handler = async (event, context) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  console.log("Headers:", JSON.stringify(event.headers, null, 2));
  console.log("Body length:", event.body ? event.body.length : 0);
  console.log("Content-Type:", event.headers["content-type"]);

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: event.headers });
    let fileData = null;
    let fileName = null;

    busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
      console.log("File event triggered");
      fileName = filename;
      const chunks = [];

      file.on("data", (data) => {
        chunks.push(data);
      });

      file.on("end", () => {
        fileData = Buffer.concat(chunks);
        console.log(`File received, size: ${fileData.length}`);
        console.log(`First 16 bytes: ${fileData.slice(0, 16).toString("hex")}`);
      });
    });

    busboy.on("finish", async () => {
      if (!fileData) {
        reject(new Error("No file data received"));
        return;
      }

      const fileHash = crypto
        .createHash("md5")
        .update(fileData)
        .digest("hex")
        .slice(0, 10);
      const s3Key = `${fileName.split(".")[0]}_${fileHash}.${fileName
        .split(".")
        .pop()}`;

      try {
        // Upload to S3
        console.log("Uploading to S3...");
        await s3Client.send(
          new PutObjectCommand({
            Bucket: "realeyes-ai-images",
            Key: s3Key,
            Body: fileData,
            ContentType: event.headers["content-type"],
          })
        );
        console.log("S3 upload successful");

        // Save to DynamoDB
        console.log("Saving to DynamoDB...");
        await dynamoDBClient.send(
          new PutItemCommand({
            TableName: "realeyes-ai-images",
            Item: {
              imageHash: { S: fileHash },
              s3ObjectUrl: {
                S: `https://realeyes-ai-images.s3.amazonaws.com/${s3Key}`,
              },
              uploadDate: { S: new Date().toISOString() },
            },
          })
        );
        console.log("DynamoDB save successful");

        resolve({
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            message: "Image uploaded successfully",
            imageHash: fileHash,
            s3ObjectUrl: `https://realeyes-ai-images.s3.amazonaws.com/${s3Key}`,
          }),
        });
      } catch (error) {
        console.error("Error:", error);
        reject(error);
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
