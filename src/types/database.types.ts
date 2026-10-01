/**
 * IMPORTANT: Replace this file with the SAME generated types you use in the
 * Next.js project, so both codebases agree on the shape of `inventory` and
 * `orders` schema tables/RPCs.
 *
 * Regenerate anytime the schema changes:
 *   npx supabase gen types typescript --project-id <your-project-ref> > src/types/database.types.ts
 *
 * Until you do that, this loose fallback keeps the build compiling but
 * gives you no type safety on Supabase calls.
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; role: "admin" | "customer" };
        Insert: { id: string; role?: "admin" | "customer" };
        Update: { id?: string; role?: "admin" | "customer" };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_admin: { Args: { uid?: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
  };
  inventory: {
    Tables: {
      stock_levels: {
        Row: {
          sku: string;
          product_id: string | null;
          size: string;
          color: string;
          available_qty: number;
          reserved_qty: number;
          physical_qty: number;
          updated_at: string;
        };
        Insert: Partial<Database["inventory"]["Tables"]["stock_levels"]["Row"]>;
        Update: Partial<Database["inventory"]["Tables"]["stock_levels"]["Row"]>;
      };
      products: {
        Row: {
          id: string;
          /** Matches the `sku` on an order line item. */
          sku_prefix: string;
          name: string;
          category: string | null;
          gsm: string | null;
          fabric: string | null;
          color: string | null;
          status: string | null;
          drop: string | null;
          image: string | null;
          images: string[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["inventory"]["Tables"]["products"]["Row"]>;
        Update: Partial<Database["inventory"]["Tables"]["products"]["Row"]>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      reserve_stock: { Args: { p_sku: string; p_qty: number }; Returns: boolean };
      release_stock: { Args: { p_sku: string; p_qty: number }; Returns: void };
      commit_stock: { Args: { p_sku: string; p_qty: number }; Returns: void };
    };
    Enums: Record<string, never>;
  };
  orders: {
    Tables: {
      checkout_reservations: {
        Row: {
          id: string;
          reservation_id: string;
          razorpay_order_id: string | null;
          customer_phone: string | null;
          items: ReservationItemJson[];
          status: "pending" | "processing" | "committed" | "released" | "expired";
          expires_at: string;
          created_at: string;
        };
        Insert: Partial<Database["orders"]["Tables"]["checkout_reservations"]["Row"]>;
        Update: Partial<Database["orders"]["Tables"]["checkout_reservations"]["Row"]>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

export interface ReservationItemJson {
  sku: string;
  qty: number;
  price: number;
  name: string;
}
