// dependencies
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const http = require("http");
require("dotenv").config();
const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Double,
  MongoDBNamespace,
  ChangeStream,
} = require("mongodb");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

// express app initialization

const app = express();
const port = 9000;

const server = http.createServer(app);
const io = new Server(server);

// middlewares

app.use(cors());
app.use(express.json());

// mongodb integration
const uri = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@cluster0.ote0m1f.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

// homepage

app.get("/", (req, res) => {
  res.send("Welcome to the server side of async tic tac toe game!");
});

// let changeStream;

async function run() {
  try {
    const userCollection = client.db("TicTacToeDB").collection("users");
    const gamesCollection = client.db("TicTacToeDB").collection("games");

    // changeStream = gamesCollection.watch();

    // changeStream.on("change", (next) => {
    //   if (next.operationType === "update") {
    //     io.emit("updatedData", next.updateDescription.updatedFields);
    //     console.log(next.updateDescription.updatedFields);
    //   }
    // });

    // register user

    app.post("/register", async (req, res) => {
      const { username, email, password, name } = req.body || {};

      if (!username || !email || !password || !name)
        return res.status(400).json({
          message: "Missing field",
        });

      // checking duplicates
      const duplicateCursor = userCollection.find({
        $or: [{ email }, { username }],
      });
      const duplicate = await duplicateCursor.toArray();
      if (duplicate.length > 0)
        return res.status(409).json({
          message: "Email or Username already exists",
        });

      // hashed password
      const hashedPassword = await bcrypt.hash(password, 10);

      // user object
      const user = {
        username,
        email,
        password: hashedPassword,
        name,
      };
      const response = await userCollection.insertOne(user);
      res.send(user);
    });

    // login user
    app.post("/login", async (req, res) => {
      const { username, password } = req.body;

      //   if null
      if (!username || !password)
        return res.status(400).json({
          message: "Missing field",
        });
      const user = await userCollection.findOne({
        username,
      });

      //   if user is not found
      if (!user) return res.status(401).json({ message: "user not found" });
      const match = await bcrypt.compare(password, user.password);

      //   if password is incorrect
      if (match) {
        // access token and refresh token
        const accessToken = jwt.sign(
          {
            username: user.username,
          },
          process.env.ACCESS_TOKEN_SECRET,
          { expiresIn: "1d" }
        );
        const refreshToken = jwt.sign(
          { username: user.username },
          process.env.REFRESH_TOKEN_SECRET,
          { expiresIn: "3d" }
        );
        user.accessToken = accessToken;
        user.refreshToken = refreshToken;

        const result = await userCollection.updateOne(
          { username: user.username },
          { $set: { refreshToken: refreshToken } }
        );
        console.log(result);
        return res.send(user);
      } else {
        res.status(401).json({ message: "Invalid password" });
      }
    });

    // refresh
    app.post("/refresh", async (req, res) => {
      const { refreshToken } = req.body || {};
      const user = await userCollection.findOne({ refreshToken });
      if (!user) res.status(404).json({ message: "User not found" });
      else res.send(user);
    });

    // logout
    app.post("/logout", async (req, res) => {
      const { username } = req.body || {};
      const response = await userCollection.updateOne(
        { username },
        { $set: { refreshToken: "" } }
      );
      res.send(response);
    });

    // update user
    app.patch("/user", async (req, res) => {
      const username = req.query.username;
      const response = await userCollection.updateOne(
        { username },
        {
          $set: {
            ...req.body,
          },
        }
      );
      res.send(response);
    });

    // check user
    app.get("/user", async (req, res) => {
      const email = req.query.email;
      const response = await userCollection.findOne({ email });
      if (response) res.send(response);
      else res.send(false);
    });

    // game settings

    // start game
    app.post("/game", async (req, res) => {
      const game = req.body;
      const timeStamp = Date.now();
      game.timeStamp = timeStamp;
      const { opponent, initiator } = game || {};

      // opponent checking
      const opponentCheck = await userCollection.findOne({
        username: opponent,
      });
      // initiator checking
      const initiatorCheck = await userCollection.findOne({
        username: initiator,
      });

      if (!opponentCheck || !initiatorCheck)
        return res.status(404).json({ message: "User not found" });
      if (opponent === initiator)
        return res
          .status(401)
          .json({ message: "You cant play this game with yourself" });

      //ongoing game checking
      if (opponentCheck.onGoingGame || initiatorCheck.onGoingGame) {
        return res
          .status(401)
          .json({ message: "Initiator or opponent have a game to finish." });
      }

      await gamesCollection.insertOne(game);
      await userCollection.updateOne(
        { username: opponent },
        { $set: { onGoingGame: game._id } }
      );
      await userCollection.updateOne(
        { username: initiator },
        { $set: { onGoingGame: game._id } }
      );

      res.send(game);
    });

    // update game
    app.patch("/game", async (req, res) => {
      const username = req.query.username;
      const gameId = req.query.id;
      const updatedData = req.body;

      const timeStamp = Date.now();
      updatedData.timeStamp = timeStamp;
      const game = await gamesCollection.findOne({ _id: ObjectId(gameId) });

      if (game.nextMove !== username) {
        return res.status(401).json({ message: "Wrong move!" });
      }
      const response = await gamesCollection.updateOne(
        { _id: ObjectId(gameId) },
        {
          $set: {
            ...updatedData,
          },
        }
      );
      io.emit("patchResponse", updatedData.matrix);
      res.send(response);
    });

    app.get("/game", async (req, res) => {
      const username = req.query.username;
      const gamesCursor = gamesCollection
        .find({
          $or: [{ initiator: username }, { opponent: username }],
        })
        .sort({ timeStamp: -1 });
      const response = await gamesCursor.toArray();

      res.send(response);
    });

    app.get("/game/:id", async (req, res) => {
      const id = ObjectId(req.params.id);
      const response = await gamesCollection.findOne({ _id: id });
      res.send(response);
    });

    // finish game
  } catch (err) {
    console.log(err);
  }
}

run();

server.listen(port, () => {
  console.log("Server is listening on port" + port);
});
