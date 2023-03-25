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

const UUIDSchema = z.string().uuid();

const CheckoutSchema = z.object({
  items: z.object({
    name: z.string(),
    price: z.number().nonnegative(),
    quantity: z.number().positive(),
    image_url: z.string().url(),
  }).array(),
  currency: z.string().length(3),
  orderId: z.string(),
  shop: z.object({
    url: z.string().url(),
    regions: z.string().array(),
  }),
});

type Setup = z.infer<typeof SetupSchema>;
type Checkout = z.infer<typeof CheckoutSchema>;

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

app.use("*", async (c, next) => {
  try {
    const authToken = c.req.headers.get("Authorization")?.split(" ")[1];
    const token = Deno.env.get("AUTH_TOKEN");

    if (authToken != undefined && token != undefined && token == authToken) {
      await next();
    } else {
      throw new AuthError("No token");
    }
  } catch (error) {
    return HandleError(error);
  }
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

app.post("/checkout/:id", async (c) => {
  try {
    const publicId = UUIDSchema.parse(c.req.param("id"));

    const results = await client
      .queryObject<
      Plugin
    >`select data from plugins where public_id = ${publicId} limit 1`;

    const shop = results.rows[0];

    const body = await c.req.json();
    const checkoutObj = CheckoutSchema.parse(body);

    const data = await GenerateCheckout({
      checkout: checkoutObj,
      stripeApiToken: shop.data.api_key,
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
    console.error(error);
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
  checkout: Checkout;
  stripeApiToken: string;
}) {
  const stripe = Stripe(params.stripeApiToken, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const cartItems = params.checkout.items.map((item) => {
    return {
      price_data: {
        currency: params.checkout.currency,
        product_data: {
          name: item.name,
          images: [item.image_url],
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
      orderId: params.checkout.orderId,
    },
    shipping_address_collection: {
      allowed_countries: params.checkout.shop.regions,
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: {
            amount: 0,
            currency: params.checkout.currency,
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
            currency: params.checkout.currency,
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
    success_url: `${params.checkout.shop.url}/success`,
    cancel_url: `${params.checkout.shop.url}/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + (3600 * 1),
  });

  return {
    type: "URL",
    id: session.id,
    value: session.url,
  };
}

serve(app.fetch);
