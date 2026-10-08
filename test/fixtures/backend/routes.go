package main

import (
	"example.com/sky_backend/handlers/clubs"
	"example.com/sky_backend/handlers/payments"
	"github.com/julienschmidt/httprouter"
)

func initializePaymentRoutes(apiMux *httprouter.Router) {
	apiMux.POST(RevelAPIVersion+"/payments/coin_packs/intent", payments.PostCoinPackIntent)
	// apiMux.GET(RevelAPIVersion+"/payments/old", payments.Old)
	apiMux.GET("/admin"+CurrentAdminAPIVersion+"/clubs/:clubId/club-payment-types", clubs.GetClubPaymentTypes)
	apiMux.GET("/admin"+CurrentAdminAPIVersion+"/clubs/:clubId/is-federated", clubs.GetIsFederatedClub)
	apiMux.GET(RevelAPIVersion+"/clubs/bookings", clubs.GetBookings)
	apiMux.GET(RevelAPIVersion+"/profile", clubs.GetProfile)
}
