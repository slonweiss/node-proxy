import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  console.log("Raw event:", event);
  console.log("Event body:", event.body);
  console.log("Is base64 encoded:", event.isBase64Encoded);

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;

  console.log("Decoded body:", body);

  const { imageHash, feedbackType, comment } = JSON.parse(body);
  if (feedbackType !== "up" && feedbackType !== "down") {
    throw new Error('Invalid feedbackType. Must be "up" or "down".');
  }

  const updateMainParams = {
    TableName: process.env.DYNAMODB_TABLE,
    Key: {
      ImageHash: { S: imageHash },
    },
    UpdateExpression:
      "ADD #feedbackType :inc SET #feedback = list_append(if_not_exists(#feedback, :empty_list), :newFeedback)",
    ExpressionAttributeNames: {
      "#feedbackType": feedbackType === "up" ? "ThumbsUp" : "ThumbsDown",
      "#feedback": "Feedback",
    },
    ExpressionAttributeValues: {
      ":inc": { N: "1" },
      ":empty_list": { L: [] },
      ":newFeedback": {
        L: [
          {
            M: {
              type: { S: feedbackType },
              comment: { S: comment },
              timestamp: { S: new Date().toISOString() },
            },
          },
        ],
      },
    },
    ReturnValues: "ALL_NEW",
  };

  try {
    const result = await dynamoDBClient.send(
      new UpdateItemCommand(updateMainParams)
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Feedback submitted successfully",
        result: result.Attributes,
      }),
    };
  } catch (error) {
    console.error("Error submitting feedback:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to submit feedback" }),
    };
  }
};
