import { serve } from "https://deno.land/std@0.155.0/http/server.ts";
import { Hono } from "https://deno.land/x/hono@v3.0.0-rc.8/mod.ts";
import Stripe from "https://esm.sh/stripe@9.9.0?target=deno";
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { z, ZodError } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import "https://deno.land/std@0.181.0/dotenv/load.ts";

const client = new Client({
  user: Deno.env.get("DATABASE_USERNAME"),
  database: Deno.env.get("DATABASE"),
  hostname: Deno.env.get("DATABASE_HOST"),
  password: Deno.env.get("DATABASE_PASSWORD"),
});

type Variables = {
  stripeApiToken: string;
};

const SetupSchema = z.object({
  api_key: z.string(),
});

type Setup = z.infer<typeof SetupSchema>;

type Plugin = {
  id: number;
  public_id: string;
  data: Setup;
};

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const app = new Hono<{ Variables: Variables }>();

app.use("*", async (_, next) => {
  await client.connect();
  await next();
  await client.end();
});

app.post("/setup", async (c) => {
  try {
    const body = await c.req.json();
    const setupObj = SetupSchema.parse(body);

    const results = await client
      .queryObject<
      Plugin
    >`INSERT INTO plugins(public_id, data) VALUES (${crypto.randomUUID()}, ${setupObj}) RETURNING public_id`;

    const id = results.rows[0].public_id;
    return c.json({ id });
  } catch (error) {
    return HandleError(error);
  }
});

app.use("*", async (c, next) => {
  try {
    const authToken = c.req.headers.get("Authorization")?.split(" ")[1];

    if (authToken != undefined) {
      const results = await client
        .queryObject<
        Plugin
      >`select data from plugins where public_id = ${authToken} limit 1`;

      const shop = results.rows[0];

      c.set("stripeApiToken", shop.data.api_key);

      await next();
    } else {
      throw new AuthError("No token");
    }
  } catch (error) {
    return HandleError(error);
  }
});

app.post("/checkout", async (c) => {
  try {
    const data = await GenerateCheckout({
      items: [{
        name: "test",
        price: 300,
        quantity: 3,
      }],
      currency: "SEK",
      orderId: "test-1",
      shop: {
        regions: ["SE", "NO", "DK", "FI"],
        url: "https://test.example.com/shop",
      },
      stripeApiToken: c.get("stripeApiToken"),
    });

    return c.json(data);
  } catch (error) {
    return HandleError(error);
  }
});

function HandleError(error: Error): Response {
  if (error instanceof ZodError) {
    return new Response(JSON.stringify(error), {
      status: 400,
    });
  } else if (error instanceof AuthError) {
    return new Response(
      JSON.stringify({
        msg: "Unauthorized",
      }),
      {
        status: 401,
      },
    );
  } else {
    return new Response(
      JSON.stringify({
        msg: "Server error, try again later",
      }),
      {
        status: 500,
      },
    );
  }
}

async function GenerateCheckout(params: {
  items: Array<{
    name: string;
    price: number;
    quantity: number;
  }>;
  currency: string;
  orderId: string;
  shop: {
    url: string;
    regions: Array<string>;
  };
  stripeApiToken: string;
}) {
  const stripe = Stripe(params.stripeApiToken, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const cartItems = params.items.map((item) => {
    return {
      price_data: {
        currency: params.currency,
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100,
      },
      adjustable_quantity: {
        enabled: true,
        minimum: 1,
        maximum: 10,
      },
      quantity: item.quantity,
    };
  });

  const session = await stripe.checkout.sessions.create({
    line_items: cartItems,
    metadata: {
      orderId: params.orderId,
    },
    shipping_address_collection: {
      allowed_countries: params.shop.regions,
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: 0,
            currency: params.currency,
          },
          display_name: "Free shipping",
          // Delivers between 5-7 business days
          delivery_estimate: {
            minimum: {
              unit: "business_day",
              value: 5,
            },
            maximum: {
              unit: "business_day",
              value: 7,
            },
          },
        },
      },
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: 1500,
            currency: params.currency,
          },
          display_name: "Next day air",
          delivery_estimate: {
            minimum: {
              unit: "business_day",
              value: 1,
            },
            maximum: {
              unit: "business_day",
              value: 2,
            },
          },
        },
      },
    ],
    mode: "payment",
    success_url: `${params.shop.url}/success`,
    cancel_url: `${params.shop.url}/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + (3600 * 1),
  });

  return {
    type: "URL",
    id: session.id,
    value: session.url,
  };
}

serve(app.fetch);
