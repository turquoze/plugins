import { Hono } from "https://deno.land/x/hono@v3.12.10/mod.ts";
import Stripe from "npm:stripe@14.14.0";
import { z, ZodError } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { logger } from "https://deno.land/x/hono@v3.12.10/middleware.ts";

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

type Checkout = z.infer<typeof CheckoutSchema>;

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const app = new Hono();

app.use("*", logger());

app.use("*", async (c, next) => {
  try {
    const authToken = c.req.header("Authorization")?.split(" ")[1];
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

app.post("/checkout/:id", async (c) => {
  try {
    //const publicId = UUIDSchema.parse(c.req.param("id"));

    const body = await c.req.json();
    const checkoutObj = CheckoutSchema.parse(body);

    const data = await GenerateCheckout({
      checkout: checkoutObj,
      stripeApiToken: Deno.env.get("STRIPE_TOKEN")!,
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
  const stripe = new Stripe(params.stripeApiToken, {
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
        unit_amount: item.price,
      },
      adjustable_quantity: {
        enabled: true,
        minimum: 1,
        maximum: 10,
      },
      quantity: item.quantity,
    };
  });

  const allowed_countries = params.checkout.shop.regions as Array<
    Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry
  >;

  const session = await stripe.checkout.sessions.create({
    line_items: cartItems,
    metadata: {
      orderId: params.checkout.orderId,
    },
    shipping_address_collection: {
      allowed_countries: allowed_countries,
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

Deno.serve(app.fetch);
