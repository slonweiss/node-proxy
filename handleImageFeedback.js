const {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const { imageHash, feedbackType, comment } = JSON.parse(event.body);
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
