//All routes related to stripe and plaid {/users/banking}

const express = require("express");
const router = new express.Router();
const User = require("../models/user");
const auth = require("../middleware/auth");
const jwt = require("jsonwebtoken");
const { sendWelcomeEmail } = require("../emails/account");
const multer = require("multer");
const sharp = require("sharp");
var moment = require("moment");
var schedule = require("node-schedule");
const sendPlaidReverificationEmail = require("../emails/plaidReverification");

require("dotenv").config();
var PUBLIC_TOKEN = process.env.PUBLIC_TOKEN;
var ACCOUNT_ID = process.env.ACCOUNT_ID;
var PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
var PLAID_SECRET = process.env.PLAID_SECRET;
var STRIPE_KEY = process.env.STRIPE_KEY;

var plaid = require("plaid");
var stripe = require("stripe")(STRIPE_KEY);
var accessToken = null || process.env.ACCESS_TOKEN;
var plaidClient = new plaid.Client({
  clientID: PLAID_CLIENT_ID,
  secret: PLAID_SECRET,
  env: plaid.environments.sandbox,
});

// End point for plaid verification first time linking bank account

router.post("/plaidverify", auth, function (request, response, next) {
  try {
    var publicToken = request.body.PUBLIC_TOKEN;
    var accountID = request.body.ACCOUNT_ID;
    plaidClient.exchangePublicToken(
      publicToken,
      function (error, tokenResponse) {
        if (error != null) {
          response.status(400).send({ error: error.error_message });
        } else {
          //Saving plaid access token server side
          accessToken = tokenResponse.access_token;
          request.user.plaidToken = accessToken;
          //Deleting any already existing link update token because fresh new account is verified
          request.user.linkUpdateToken = "";
          request.user.save();
          plaidClient.createStripeToken(
            accessToken,
            accountID,
            function (err, res) {
              if (err != null || res == undefined) {
                response.status(400).send({ error: error.error_message });
              } else {
                var bankAccountToken = res.stripe_bank_account_token;

                //Creating a Stripe customer object when linking bank account for first time
                //Checking if Stripe Customer exists
                if (!request.user.stripeCustomerId) {
                  stripe.customers.create(
                    {
                      name: `${request.user.firstName} ${request.user.lastName}`,
                      email: request.user.email,
                      source: bankAccountToken,
                    },
                    function (err, customer) {
                      if (err) {
                        response.status(400).send({ error: err.message });
                      } else {
                        request.user.bankLinked = true;
                        request.user.stripeCustomerId = customer.id;
                        request.user.save();
                        response.send();
                      }
                    }
                  );
                }
                //Updating existing stripe customer by attaching the new source
                else {
                  stripe.customers.update(
                    request.user.stripeCustomerId,
                    { source: bankAccountToken },
                    function (err, customer) {
                      if (err) {
                        response.status(400).send({ error: err.message });
                      } else {
                        request.user.bankLinked = true;
                        request.user.save();
                        response.send();
                      }
                    }
                  );
                }
              }
            }
          );
        }
      }
    );
  } catch (error) {
    response.status(500).send({ error: error.message });
  }
});

// Endpoint to create a one-time use link_token
// Used to initialize Link in update mode for the user
router.post(
  "/create_link_token",
  auth,
  async function (request, response, next) {
    try {
      const linkTokenResponse = await plaidClient.createLinkToken({
        user: {
          client_user_id: "UNIQUE_USER_ID",
        },
        client_name: "Everchange",
        country_codes: ["US"],
        language: "en",
        access_token: request.user.plaidToken,
      });
      request.user.linkUpdateToken = linkTokenResponse.link_token;
      await request.user.save();
      response.send();
    } catch (error) {
      response.status(500).send(error);
    }
  }
);

// End point for plaid link update i.e bank account reverification

router.post("/plaidupdate", auth, async function (req, res, next) {
  try {
    req.user.linkUpdateToken = "";
    await req.user.save();
    res.send();
  } catch {
    res.status(500).send();
  }
});

// Endpoint to retrieve real-time Balances for each of an Item's accounts
router.get("/api/balance", auth, async function (req, res, next) {
  plaidClient.getBalance(
    req.user.plaidToken,
    async function (error, balanceResponse) {
      if (error != null) {
        if (error.error_code === "ITEM_LOGIN_REQUIRED") {
          sendPlaidReverificationEmail(req.user.email, req.user.firstName);

          const linkTokenResponse = await getUpdateLinkToken(req.user);
          res.send({
            error: error.error_message,
            link_token: linkTokenResponse.link_token,
          });
        } else {
          res.send({
            error: error.error_message,
          });
        }
      }
      res.send(balanceResponse);
    }
  );
});

//Endpoint to retrieve Transactions for an Item and sending the total amount to be charged through Stripe
router.get("/api/transactions", auth, function (req, res, next) {
  // Pull transactions for the Item for the last 30 days
  var startDate = moment().subtract(30, "days").format("YYYY-MM-DD");
  var endDate = moment().format("YYYY-MM-DD");
  plaidClient.getTransactions(
    req.user.plaidToken,
    startDate,
    endDate,
    {
      count: 250,
      offset: 0,
    },
    async function (error, transactionsResponse) {
      if (error != null) {
        if (error.error_code === "ITEM_LOGIN_REQUIRED") {
          sendPlaidReverificationEmail(req.user.email, req.user.firstName);
          const linkTokenResponse = await getUpdateLinkToken(req.user);
          res.send({
            error: error.error_message,
            link_token: linkTokenResponse.link_token,
          });
        } else {
          res.send({
            error: error.error_message,
          });
        }
      } else {
        let transactionsDetails = transactionsResponse.transactions;
        let amountCharged = 0;
        transactionsDetails.map((item) => {
          let roundingup = Math.ceil(item["amount"]) - item["amount"];
          amountCharged += roundingup;
        });
        res.send({
          total: amountCharged.toFixed(2),
        });
      }
    }
  );
});

// Function to create a one-time use link_token
// Used to initialize Link in update mode for the user

async function getUpdateLinkToken(user) {
  const linkTokenResponse = await plaidClient
    .createLinkToken({
      user: {
        client_user_id: "UNIQUE_USER_ID",
      },
      client_name: "Everchange",
      country_codes: ["US"],
      language: "en",
      access_token: user.plaidToken,
    })
    .catch((err) => {
      console.log("Error: " + err);
    });
  return linkTokenResponse;
}

// Function to retrieve Transactions for an user and sending the total amount to be charged through Stripe
async function amountToCharge(user) {
  // Pull transactions for the Item for the last 7 days i.e. from previous sunday to saturday
  var startDate = moment().subtract(7, "days").format("YYYY-MM-DD");
  var endDate = moment().subtract(1, "days").format("YYYY-MM-DD");
  try {
    const response = await plaidClient.getTransactions(
      user.plaidToken,
      startDate,
      endDate,
      {}
    );
    const transactionsDetails = response.transactions;
    let amountCharged = 0;
    transactionsDetails.map((item) => {
      let roundingup = Math.ceil(item["amount"]) - item["amount"];
      amountCharged += roundingup;
    });
    return Math.floor(amountCharged.toFixed(2) * 100);
  } catch (error) {
    if (error.error_code === "ITEM_LOGIN_REQUIRED") {
      sendPlaidReverificationEmail(user.email, user.firstName);
      const linkTokenResponse = await getUpdateLinkToken(user);
      user.linkUpdateToken = linkTokenResponse.link_token;
      await user.save();
      return 0;
    }
  }
}

//Function to Charge each user through Stripe
chargingUsers = async () => {
  let users = await User.find({ bankLinked: true });
  users.map(async (user) => {
    if (!user.leftOverAmount) {
      user.leftOverAmount = 0;
    }
    let amount = (await amountToCharge(user)) + user.leftOverAmount;
    if (amount < 50) {
      user.leftOverAmount = amount;
      await user.save();
    } else {
      const charge = await stripe.charges.create({
        amount: amount,
        currency: "usd",
        customer: user.stripeCustomerId,
      });
      user.leftOverAmount = 0;
      user.amountsCharged;
      user.amountsCharged = user.amountsCharged.concat({
        amount,
        dateCharged: new Date(),
      });
      await user.save();
    }
  });
};

//recurrent function to run every sunday at 00:05 AM
var recurrentFunction = schedule.scheduleJob(
  { hour: 0, minute: 5, dayOfWeek: 0, tz: "US/Central" },
  function () {
    chargingUsers();
  }
);

//Endpoint for Updating Plaid Bank account linking status
router.post("/plaiddelete", auth, async function (req, res, next) {
  try {
    if (req.user.plaidToken) {
      req.user.bankLinked = !req.user.bankLinked;
      await req.user.save();
      res.send();
    } else {
      res.status(400).send();
    }
  } catch {
    res.status(500).send();
  }
});

module.exports = router;
