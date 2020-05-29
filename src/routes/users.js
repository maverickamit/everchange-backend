const express = require("express");
const router = new express.Router();
const User = require("../db/models/user");

//creating new user endpoint
router.post("/", async (req, res) => {
  const user = new User(req.body);
  try {
    await user.save();
    res.status(201).send(user);
  } catch (err) {
    res.status(400).send(err);
  }
});

// Reading User Endpoint
//Getting a list of all Users

router.get("/", (req, res) => {
  User.find({})
    .then((users) => {
      res.send(users);
    })
    .catch((e) => {
      res.status(500).send();
    });
});

module.exports = router;
